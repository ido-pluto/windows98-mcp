/*
 * WIN98CTL - Windows 98 remote-control guest.
 * C89/Win32 source; intentionally avoids SendInput, Unicode APIs and APIs
 * introduced after Windows 98.  Transport is authenticated but not encrypted.
 */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <wincrypt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <direct.h>
#include <io.h>
#include "protocol.h"

#define BUILD_ID "win98ctl-0.3.3"
#define MAX_SESSIONS 8
#define MAX_TRANSFERS 4
#define IO_CHUNK 32768
#define FILE_CHUNK 65536UL
#define SHELL_REPLAY_BYTES 131072UL
#define LOG_LIMIT_BYTES 262144UL
#define IDLE_SLEEP 20
#define HANDSHAKE_TIMEOUT_MS 15000UL
#define CONTROL_IDLE_TIMEOUT_MS 45000UL
#define RECONNECT_DELAY_MS 2000UL
#define ID_CLOSE_BUTTON 1001
#define WM_AGENT_STATUS (WM_USER+1)
#define WM_AGENT_WORKER_DONE (WM_USER+2)
#ifndef SM_MOUSEWHEELPRESENT
#define SM_MOUSEWHEELPRESENT 75
#endif

typedef struct {
    int used;
    unsigned long id;
    PROCESS_INFORMATION pi;
    HANDLE in_write, out_read;
    unsigned char *replay;
    unsigned long replay_len;
    unsigned long replay_start;
    unsigned long cursor;
    int exited;
    unsigned long exit_code;
} SHELL_SESSION;

typedef struct {
    int used;
    int overwrite;
    unsigned long id;
    char final_path[MAX_PATH];
    char temp_path[MAX_PATH];
    char meta_path[MAX_PATH];
    HANDLE file;
    unsigned long expected_size;
    unsigned long offset;
    W98_SHA256_CTX sha;
    char expected_sha[65];
} FILE_TRANSFER;

typedef struct {
    char host[128];
    unsigned short port;
    char guest_id[64];
    w98_u8 psk[64];
    unsigned long psk_len;
    char ini_path[MAX_PATH];
    char log_path[MAX_PATH];
} CONFIG;

/* GetCursorInfo is not declared by Win98 SDK headers; resolve it optionally. */
typedef struct {
    DWORD cbSize;
    DWORD flags;
    HCURSOR hCursor;
    POINT ptScreenPos;
} W98_CURSORINFO;
#define W98_CURSOR_SHOWING 1

static CONFIG cfg;
static SHELL_SESSION sessions[MAX_SESSIONS];
static FILE_TRANSFER transfers[MAX_TRANSFERS];
static unsigned long next_session=1,next_transfer=1;
static int held_buttons=0;
static unsigned char held_keys[256];
static FILE *log_file;
static unsigned char *pending_binary;
static unsigned long pending_binary_len;
static unsigned long pending_binary_stream=0x80000000UL;
static int json_string_error;
static int safe_format(char*out,unsigned long cap,const char*fmt,const char*a,const char*b);
static char *ok_data(const char*data);
static char *error_result(const char*code,const char*msg);
static SOCKET control_socket=INVALID_SOCKET;
static w98_u8 control_key[32];
static unsigned long control_tx_sequence;
static unsigned long control_rx_sequence;
static int control_cancelled;
static int control_aborted;
static int control_dead;
static HANDLE agent_stop_event;
static HANDLE agent_worker_thread;
static CRITICAL_SECTION agent_status_lock;
static CRITICAL_SECTION agent_socket_lock;
static char agent_status_text[256]="Starting...";
static SOCKET agent_active_socket=INVALID_SOCKET;
static HWND agent_main_window;
static HWND agent_status_window;
static HWND agent_close_button;
static int agent_ui_stopping;
static int cooperative_stop(void);
static int cooperative_sleep(unsigned long milliseconds);
static int agent_stop_requested(void);
static void set_agent_status(const char*text);

static void rotate_log_if_needed(void) {
    long size=0;char old_path[MAX_PATH];
    if(log_file){size=ftell(log_file);if(size<0)size=0;if((unsigned long)size<LOG_LIMIT_BYTES)return;fclose(log_file);log_file=0;}
    else{FILE*f=fopen(cfg.log_path,"rb");if(f){fseek(f,0,SEEK_END);size=ftell(f);fclose(f);}if(size<0||(unsigned long)size<LOG_LIMIT_BYTES)return;}
    if(safe_format(old_path,MAX_PATH,"%s.OLD",cfg.log_path,0)){DeleteFileA(old_path);MoveFileA(cfg.log_path,old_path);}
}
static void log_line(const char *s) {
    SYSTEMTIME t;
    GetLocalTime(&t);rotate_log_if_needed();
    if(!log_file) log_file=fopen(cfg.log_path,"a");
    if(log_file){fprintf(log_file,"%04u-%02u-%02u %02u:%02u:%02u %s\n",
      t.wYear,t.wMonth,t.wDay,t.wHour,t.wMinute,t.wSecond,s);fflush(log_file);}
}

static int agent_stop_requested(void) {
    return agent_stop_event&&WaitForSingleObject(agent_stop_event,0)==WAIT_OBJECT_0;
}
static int wait_for_agent_stop(unsigned long milliseconds) {
    if(!agent_stop_event){Sleep(milliseconds);return 0;}
    return WaitForSingleObject(agent_stop_event,milliseconds)==WAIT_OBJECT_0;
}
static void set_agent_status(const char*text) {
    EnterCriticalSection(&agent_status_lock);strncpy(agent_status_text,text,sizeof(agent_status_text)-1);agent_status_text[sizeof(agent_status_text)-1]=0;LeaveCriticalSection(&agent_status_lock);
    if(agent_main_window)PostMessageA(agent_main_window,WM_AGENT_STATUS,0,0);
}
static void set_agent_socket(SOCKET s) {
    EnterCriticalSection(&agent_socket_lock);agent_active_socket=s;LeaveCriticalSection(&agent_socket_lock);
}
static void close_agent_socket(SOCKET s) {
    int owned=0;EnterCriticalSection(&agent_socket_lock);if(agent_active_socket==s){agent_active_socket=INVALID_SOCKET;owned=1;}LeaveCriticalSection(&agent_socket_lock);
    if(owned){shutdown(s,SD_BOTH);closesocket(s);}
}
static void interrupt_agent_socket(void) {
    SOCKET s;EnterCriticalSection(&agent_socket_lock);s=agent_active_socket;agent_active_socket=INVALID_SOCKET;LeaveCriticalSection(&agent_socket_lock);
    if(s!=INVALID_SOCKET){shutdown(s,SD_BOTH);closesocket(s);}
}

static void json_escape(const char *s,char *out,unsigned long cap) {
    unsigned long n=0;unsigned char c;WCHAR wc;int take,k;
    while(*s&&n+7<cap){c=(unsigned char)*s;
      if(c>=128){take=IsDBCSLeadByte(c)&&s[1]?2:1;k=MultiByteToWideChar(CP_ACP,MB_PRECOMPOSED,s,take,&wc,1);if(k){sprintf(out+n,"\\u%04x",(unsigned int)wc);n+=6;s+=take;continue;}c='?';s++;}
      else s++;
      if(c=='"'||c=='\\'){out[n++]='\\';out[n++]=c;}
      else if(c=='\r'){out[n++]='\\';out[n++]='r';}
      else if(c=='\n'){out[n++]='\\';out[n++]='n';}
      else if(c=='\t'){out[n++]='\\';out[n++]='t';}
      else if(c<32){sprintf(out+n,"\\u%04x",c);n+=6;}else out[n++]=c;
    }out[n]=0;
}

/* Minimal parser for the broker's flat request envelopes and method params. */
static const char *json_value(const char *j,const char *key) {
    char pat[96];const char*p;sprintf(pat,"\"%s\"",key);p=strstr(j,pat);if(!p)return 0;
    p+=strlen(pat);while(*p==' '||*p=='\t'||*p=='\r'||*p=='\n')p++;if(*p++!=':')return 0;
    while(*p==' '||*p=='\t'||*p=='\r'||*p=='\n')p++;return p;
}

static int hex_value(int c) {
    if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;if(c>='A'&&c<='F')return c-'A'+10;return -1;
}

static int append_acp_codepoint(unsigned long cp,char*out,unsigned long cap,unsigned long*n) {
    WCHAR wc;char mb[8];BOOL used=FALSE;int k;
    if(cp>0xffffUL||(cp>=0xd800UL&&cp<=0xdfffUL))return 2;
    wc=(WCHAR)cp;k=WideCharToMultiByte(CP_ACP,0,&wc,1,mb,sizeof(mb),0,&used);
    if(!k||used)return 2;if(*n+(unsigned long)k>=cap)return 3;memcpy(out+*n,mb,k);*n+=(unsigned long)k;return 0;
}

static char *json_string_convert(const char*j,const char*key) {
    const unsigned char*p=(const unsigned char*)json_value(j,key);const unsigned char*q;char*out;unsigned long cap,n=0,cp;int h1,h2,h3,h4,e;
    json_string_error=1;if(!p||*p!='"')return 0;p++;q=p;while(*q&&*q!='"'){if(*q=='\\'&&q[1])q++;q++;}if(*q!='"')return 0;
    cap=(unsigned long)(q-p)+1;out=(char*)malloc(cap);if(!out){json_string_error=3;return 0;}
    while(p<q){cp=*p++;
      if(cp=='\\'){if(p>=q){free(out);return 0;}cp=*p++;
        if(cp=='"'||cp=='\\'||cp=='/'){}
        else if(cp=='b')cp='\b';else if(cp=='f')cp='\f';else if(cp=='n')cp='\n';else if(cp=='r')cp='\r';else if(cp=='t')cp='\t';
        else if(cp=='u'){if(q-p<4){free(out);return 0;}h1=hex_value(p[0]);h2=hex_value(p[1]);h3=hex_value(p[2]);h4=hex_value(p[3]);if(h1<0||h2<0||h3<0||h4<0){free(out);return 0;}cp=(unsigned long)((h1<<12)|(h2<<8)|(h3<<4)|h4);p+=4;
          if(cp>=0xd800UL&&cp<=0xdbffUL){unsigned long low;if(q-p<6||p[0]!='\\'||p[1]!='u'){json_string_error=2;free(out);return 0;}h1=hex_value(p[2]);h2=hex_value(p[3]);h3=hex_value(p[4]);h4=hex_value(p[5]);if(h1<0||h2<0||h3<0||h4<0){free(out);return 0;}low=(unsigned long)((h1<<12)|(h2<<8)|(h3<<4)|h4);if(low<0xdc00UL||low>0xdfffUL){free(out);return 0;}cp=0x10000UL+((cp-0xd800UL)<<10)+(low-0xdc00UL);p+=6;}
        }else{free(out);return 0;}
      }else if(cp<0x20){free(out);return 0;}
      else if(cp>=0x80){unsigned long min;int need,i;if((cp&0xe0)==0xc0){need=1;cp&=0x1f;min=0x80;}else if((cp&0xf0)==0xe0){need=2;cp&=0x0f;min=0x800;}else if((cp&0xf8)==0xf0){need=3;cp&=7;min=0x10000;}else{free(out);return 0;}if(q-p<need){free(out);return 0;}for(i=0;i<need;i++){if((p[i]&0xc0)!=0x80){free(out);return 0;}cp=(cp<<6)|(p[i]&0x3f);}p+=need;if(cp<min||cp>0x10ffffUL||(cp>=0xd800UL&&cp<=0xdfffUL)){free(out);return 0;}}
      if(!cp){free(out);return 0;}e=append_acp_codepoint(cp,out,cap,&n);if(e){json_string_error=e;free(out);return 0;}
    }
    out[n]=0;json_string_error=0;return out;
}

static int json_string(const char*j,const char*key,char*out,unsigned long cap) {
    char*converted;unsigned long n;if(cap)out[0]=0;if(cap<1)return 0;converted=json_string_convert(j,key);if(!converted)return 0;n=strlen(converted);if(n>=cap){json_string_error=3;free(converted);return 0;}memcpy(out,converted,n+1);free(converted);return 1;
}
static char *json_string_alloc(const char*j,const char*key) {
    return json_string_convert(j,key);
}
static long json_long(const char*j,const char*key,long def) {
    const char*p=json_value(j,key);if(!p)return def;return strtol(p,0,10);
}
static unsigned long json_id(const char*j,const char*key,unsigned long def) {
    const char*p=json_value(j,key);if(!p)return def;if(*p=='"')p++;return strtoul(p,0,10);
}
static int json_bool(const char*j,const char*key,int def) {
    const char*p=json_value(j,key);if(!p)return def;if(!strncmp(p,"true",4))return 1;if(!strncmp(p,"false",5))return 0;return def;
}

static int safe_format(char*out,unsigned long cap,const char*fmt,const char*a,const char*b) {
    int n;
    if(!out||!cap)return 0;
    n=_snprintf(out,cap,fmt,a?a:"",b?b:"");
    if(n<0||(unsigned long)n>=cap){out[cap-1]=0;return 0;}
    return 1;
}

static int path_child(const char*parent,const char*name,char out[MAX_PATH]) {
    return safe_format(out,MAX_PATH,"%s\\%s",parent,name);
}

static int path_pattern(const char*path,char out[MAX_PATH]) {
    return safe_format(out,MAX_PATH,"%s\\*.*",path,0);
}

static int get_json_path(const char*j,const char*key,char out[MAX_PATH]) {
    return json_string(j,key,out,MAX_PATH)&&out[0]!=0;
}

static int screen_color_depth(void) {
    HDC dc=GetDC(0);int depth=0;
    if(dc){depth=GetDeviceCaps(dc,BITSPIXEL)*GetDeviceCaps(dc,PLANES);ReleaseDC(0,dc);}
    return depth;
}

static char *base64_encode(const unsigned char *in,unsigned long n) {
    static const char t[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    char*out=(char*)malloc(((n+2)/3)*4+1);unsigned long i,o=0;unsigned long v;if(!out)return 0;
    for(i=0;i<n;i+=3){v=(unsigned long)in[i]<<16;if(i+1<n)v|=(unsigned long)in[i+1]<<8;if(i+2<n)v|=in[i+2];
      out[o++]=t[(v>>18)&63];out[o++]=t[(v>>12)&63];out[o++]=i+1<n?t[(v>>6)&63]:'=';out[o++]=i+2<n?t[v&63]:'=';}
    out[o]=0;return out;
}
static char *ascii_escape_bytes(const unsigned char *in,unsigned long n) {
    char*out=(char*)malloc(n*2+1);unsigned long i,o=0;if(!out)return 0;
    for(i=0;i<n;i++){unsigned char c=in[i];if(c=='"'||c=='\\'){out[o++]='\\';out[o++]=c;}else if(c=='\r'){out[o++]='\\';out[o++]='r';}else if(c=='\n'){out[o++]='\\';out[o++]='n';}else if(c=='\t'){out[o++]='\\';out[o++]='t';}else out[o++]=(c>=32&&c<127)?c:'?';}out[o]=0;return out;
}
static int b64v(int c){if(c>='A'&&c<='Z')return c-'A';if(c>='a'&&c<='z')return c-'a'+26;if(c>='0'&&c<='9')return c-'0'+52;if(c=='+')return 62;if(c=='/')return 63;return -1;}
static unsigned char *base64_decode(const char*s,unsigned long*out_n) {
    unsigned long n=strlen(s),i,o=0;unsigned char*out;int a,b,c,d;
    out=(unsigned char*)malloc(n/4*3+3);if(!out)return 0;
    for(i=0;i+3<n;i+=4){a=b64v(s[i]);b=b64v(s[i+1]);c=s[i+2]=='='?-1:b64v(s[i+2]);d=s[i+3]=='='?-1:b64v(s[i+3]);
      if(a<0||b<0||(c<0&&s[i+2]!='=')||(d<0&&s[i+3]!='=')){free(out);return 0;}
      out[o++]=(unsigned char)((a<<2)|(b>>4));if(c>=0)out[o++]=(unsigned char)((b<<4)|(c>>2));if(d>=0)out[o++]=(unsigned char)((c<<6)|d);}
    *out_n=o;return out;
}

static unsigned long crc32_bytes(const unsigned char*p,unsigned long n) {
    unsigned long c=0xffffffffUL,i;int k;for(i=0;i<n;i++){c^=p[i];for(k=0;k<8;k++)c=(c>>1)^((c&1)?0xedb88320UL:0);}return c^0xffffffffUL;
}
static int sha256_handle(HANDLE f,char hex[65]) {
    W98_SHA256_CTX hc;unsigned char digest[32],buf[IO_CHUNK];DWORD got;
    if(SetFilePointer(f,0,0,FILE_BEGIN)==0xffffffffUL&&GetLastError()!=NO_ERROR)return 0;
    w98_sha256_init(&hc);do{if(!ReadFile(f,buf,sizeof(buf),&got,0))return 0;if(got)w98_sha256_update(&hc,buf,got);}while(got);
    w98_sha256_final(&hc,digest);w98_hex(digest,32,hex);return 1;
}

static int transfer_meta_state(FILE_TRANSFER*t) {
    FILE*f;unsigned long size=0;char magic[24],sha[80];int temp_exists=GetFileAttributesA(t->temp_path)!=0xffffffffUL,meta_exists=GetFileAttributesA(t->meta_path)!=0xffffffffUL;
    if(!temp_exists&&!meta_exists)return 0;if(!temp_exists||!meta_exists)return -1;f=fopen(t->meta_path,"r");if(!f)return -1;magic[0]=sha[0]=0;
    if(fscanf(f,"%23s\n%lu\n%79s",magic,&size,sha)!=3){fclose(f);return -1;}fclose(f);if(strcmp(magic,"WIN98CTL_RESUME_V1"))return -1;
    return size==t->expected_size&&!stricmp(sha,t->expected_sha)?1:2;
}
static int write_transfer_meta(FILE_TRANSFER*t) {
    FILE*f=fopen(t->meta_path,"w");if(!f)return 0;fprintf(f,"WIN98CTL_RESUME_V1\n%lu\n%s\n",t->expected_size,t->expected_sha);fclose(f);return 1;
}
static int rehash_transfer_prefix(FILE_TRANSFER*t) {
    unsigned char buf[IO_CHUNK];DWORD got,size;size=GetFileSize(t->file,0);if(size==0xffffffffUL&&GetLastError()!=NO_ERROR)return 0;if(size>t->expected_size)return 0;
    if(SetFilePointer(t->file,0,0,FILE_BEGIN)==0xffffffffUL&&GetLastError()!=NO_ERROR)return 0;w98_sha256_init(&t->sha);
    do{if(!ReadFile(t->file,buf,sizeof(buf),&got,0))return 0;if(got)w98_sha256_update(&t->sha,buf,got);}while(got);
    if(SetFilePointer(t->file,size,0,FILE_BEGIN)==0xffffffffUL&&GetLastError()!=NO_ERROR)return 0;t->offset=size;return 1;
}

static void cleanup_input(void) {
    int i;
    for(i=0;i<256;i++)if(held_keys[i]){keybd_event((BYTE)i,0,KEYEVENTF_KEYUP,0);held_keys[i]=0;}
    if(held_buttons&1)mouse_event(MOUSEEVENTF_LEFTUP,0,0,0,0);
    if(held_buttons&2)mouse_event(MOUSEEVENTF_RIGHTUP,0,0,0,0);
    if(held_buttons&4)mouse_event(MOUSEEVENTF_MIDDLEUP,0,0,0,0);
    held_buttons=0;
}
static void cleanup_sessions(void) {
    int i;for(i=0;i<MAX_SESSIONS;i++)if(sessions[i].used){
      TerminateProcess(sessions[i].pi.hProcess,1);CloseHandle(sessions[i].pi.hProcess);CloseHandle(sessions[i].pi.hThread);
      if(sessions[i].in_write)CloseHandle(sessions[i].in_write);if(sessions[i].out_read)CloseHandle(sessions[i].out_read);if(sessions[i].replay)free(sessions[i].replay);memset(&sessions[i],0,sizeof(sessions[i]));}
}
static void cleanup_transfers(void) {
    int i;for(i=0;i<MAX_TRANSFERS;i++)if(transfers[i].used){CloseHandle(transfers[i].file);memset(&transfers[i],0,sizeof(transfers[i]));}
}

static int move_pointer(int x,int y) {
    int w=GetSystemMetrics(SM_CXSCREEN),h=GetSystemMetrics(SM_CYSCREEN);
    if(x<0||y<0||x>=w||y>=h)return 0;return SetCursorPos(x,y)!=0;
}
static int button_flag(const char*b,int down) {
    if(!strcmp(b,"right"))return down?MOUSEEVENTF_RIGHTDOWN:MOUSEEVENTF_RIGHTUP;
    if(!strcmp(b,"middle"))return down?MOUSEEVENTF_MIDDLEDOWN:MOUSEEVENTF_MIDDLEUP;
    return down?MOUSEEVENTF_LEFTDOWN:MOUSEEVENTF_LEFTUP;
}
static int button_bit(const char*b){return!strcmp(b,"right")?2:!strcmp(b,"middle")?4:1;}
static void key_action(int vk,int scan,int down,int extended) {
    DWORD fl=down?0:KEYEVENTF_KEYUP;if(extended)fl|=KEYEVENTF_EXTENDEDKEY;
    if(!scan)scan=MapVirtualKeyA((UINT)vk,0);keybd_event((BYTE)vk,(BYTE)scan,fl,0);held_keys[vk&255]=(unsigned char)down;
}
static int named_key(const char*n) {
    static const struct{const char*n;int k;} map[]={{"ENTER",VK_RETURN},{"ESCAPE",VK_ESCAPE},{"ESC",VK_ESCAPE},{"TAB",VK_TAB},
      {"BACKSPACE",VK_BACK},{"DELETE",VK_DELETE},{"INSERT",VK_INSERT},{"HOME",VK_HOME},{"END",VK_END},{"PAGEUP",VK_PRIOR},
      {"PAGEDOWN",VK_NEXT},{"UP",VK_UP},{"DOWN",VK_DOWN},{"LEFT",VK_LEFT},{"RIGHT",VK_RIGHT},{"CTRL",VK_CONTROL},
      {"CONTROL",VK_CONTROL},{"ALT",VK_MENU},{"SHIFT",VK_SHIFT},{"WINDOWS",0x5b},{"SPACE",VK_SPACE}};
    int i;if(strlen(n)==1)return VkKeyScanA(n[0])&255;
    if((n[0]=='F'||n[0]=='f')&&atoi(n+1)>=1&&atoi(n+1)<=12)return VK_F1+atoi(n+1)-1;
    for(i=0;i<(int)(sizeof(map)/sizeof(map[0]));i++)if(!stricmp(n,map[i].n))return map[i].k;return -1;
}
static int type_text(const char*s,int delay) {
    SHORT k;int vk,mods;while(*s){if(cooperative_stop()){cleanup_input();return -1;}k=VkKeyScanA(*s++);if(k==-1)return 0;vk=k&255;mods=(k>>8)&255;
      if(mods&1)key_action(VK_SHIFT,0,1,0);if(mods&2)key_action(VK_CONTROL,0,1,0);if(mods&4)key_action(VK_MENU,0,1,0);
      key_action(vk,0,1,0);key_action(vk,0,0,0);
      if(mods&4)key_action(VK_MENU,0,0,0);if(mods&2)key_action(VK_CONTROL,0,0,0);if(mods&1)key_action(VK_SHIFT,0,0,0);
      if(delay&&!cooperative_sleep((unsigned long)delay)){cleanup_input();return -1;}
    }return 1;
}
static int hotkey_array(const char*j) {
    const char*p=json_value(j,"keys");char key[64];int vks[16],n=0,i,k;
    if(!p||*p!='[')return 0;p++;
    while(*p&&*p!=']'&&n<16){while(*p&&*p!='"'&&*p!=']')p++;if(*p==']')break;p++;i=0;
      while(*p&&*p!='"'&&i<63)key[i++]=*p++;key[i]=0;if(*p=='"')p++;k=named_key(key);if(k<0)return 0;vks[n++]=k;}
    if(!n)return 0;for(i=0;i<n;i++)key_action(vks[i],0,1,0);for(i=n-1;i>=0;i--)key_action(vks[i],0,0,0);return 1;
}

static unsigned char *capture_bmp(int x,int y,int w,int h,int cursor,unsigned long*out_n) {
    HDC screen=0,mem=0;HBITMAP bmp=0,old;BITMAPINFO bi;BITMAPFILEHEADER bf;unsigned char*pixels,*out;unsigned long stride,pix_n;W98_CURSORINFO ci;ICONINFO ii;
    typedef BOOL (WINAPI *PFN_GETCURSORINFO)(W98_CURSORINFO*);PFN_GETCURSORINFO get_ci;
    HCURSOR fallback_cursor;POINT fallback_pos;
    *out_n=0;if(w<=0)w=GetSystemMetrics(SM_CXSCREEN);if(h<=0)h=GetSystemMetrics(SM_CYSCREEN);
    if(x<0||y<0||w<=0||h<=0||x>=GetSystemMetrics(SM_CXSCREEN)||y>=GetSystemMetrics(SM_CYSCREEN)||
       w>GetSystemMetrics(SM_CXSCREEN)-x||h>GetSystemMetrics(SM_CYSCREEN)-y)return 0;
    old=0;
    stride=((w*3+3)/4)*4;pix_n=stride*h;screen=GetDC(0);mem=CreateCompatibleDC(screen);bmp=CreateCompatibleBitmap(screen,w,h);
    if(!screen||!mem||!bmp)goto fail;old=(HBITMAP)SelectObject(mem,bmp);BitBlt(mem,0,0,w,h,screen,x,y,SRCCOPY);
    get_ci=(PFN_GETCURSORINFO)GetProcAddress(GetModuleHandleA("USER32.DLL"),"GetCursorInfo");
    if(cursor&&get_ci){memset(&ci,0,sizeof(ci));ci.cbSize=sizeof(ci);if(get_ci(&ci)&&ci.flags==W98_CURSOR_SHOWING&&GetIconInfo(ci.hCursor,&ii)){
      DrawIcon(mem,ci.ptScreenPos.x-x-(int)ii.xHotspot,ci.ptScreenPos.y-y-(int)ii.yHotspot,ci.hCursor);DeleteObject(ii.hbmMask);if(ii.hbmColor)DeleteObject(ii.hbmColor);}}
    else if(cursor&&!get_ci){fallback_cursor=GetCursor();if(fallback_cursor&&GetCursorPos(&fallback_pos)&&GetIconInfo(fallback_cursor,&ii)){
      DrawIcon(mem,fallback_pos.x-x-(int)ii.xHotspot,fallback_pos.y-y-(int)ii.yHotspot,fallback_cursor);DeleteObject(ii.hbmMask);if(ii.hbmColor)DeleteObject(ii.hbmColor);}}
    memset(&bi,0,sizeof(bi));bi.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);bi.bmiHeader.biWidth=w;bi.bmiHeader.biHeight=h;bi.bmiHeader.biPlanes=1;bi.bmiHeader.biBitCount=24;bi.bmiHeader.biCompression=BI_RGB;
    SelectObject(mem,old);old=0;
    pixels=(unsigned char*)malloc(pix_n);if(!pixels)goto fail2;if(!GetDIBits(mem,bmp,0,h,pixels,&bi,DIB_RGB_COLORS)){free(pixels);goto fail2;}
    memset(&bf,0,sizeof(bf));bf.bfType=0x4d42;bf.bfOffBits=sizeof(bf)+sizeof(BITMAPINFOHEADER);bf.bfSize=bf.bfOffBits+pix_n;
    out=(unsigned char*)malloc(bf.bfSize);if(!out){free(pixels);goto fail2;}memcpy(out,&bf,sizeof(bf));memcpy(out+sizeof(bf),&bi.bmiHeader,sizeof(BITMAPINFOHEADER));memcpy(out+bf.bfOffBits,pixels,pix_n);free(pixels);*out_n=bf.bfSize;
    if(old)SelectObject(mem,old);DeleteObject(bmp);DeleteDC(mem);ReleaseDC(0,screen);return out;
fail2: if(old)SelectObject(mem,old);
fail: if(bmp)DeleteObject(bmp);if(mem)DeleteDC(mem);if(screen)ReleaseDC(0,screen);return 0;
}
static int queue_full_screenshot(char descriptor[180]) {
    W98_SHA256_CTX hc;unsigned char digest[32];char hex[65];unsigned long n;unsigned char*bmp;
    bmp=capture_bmp(0,0,0,0,1,&n);if(!bmp)return 0;if(pending_binary)free(pending_binary);
    pending_binary=bmp;pending_binary_len=n;pending_binary_stream++;w98_sha256_init(&hc);w98_sha256_update(&hc,bmp,n);w98_sha256_final(&hc,digest);w98_hex(digest,32,hex);
    sprintf(descriptor,",\"binary\":{\"streamId\":%lu,\"totalBytes\":%lu,\"sha256\":\"%s\",\"mimeType\":\"image/bmp\"}",pending_binary_stream,n,hex);return 1;
}

static SHELL_SESSION *find_session(unsigned long id){int i;for(i=0;i<MAX_SESSIONS;i++)if(sessions[i].used&&sessions[i].id==id)return&sessions[i];return 0;}
static int command_is_direct_bash(const char*command) {
    const char*p=command,*base;char name[32];int n=0;while(*p==' '||*p=='\t')p++;if(*p=='"')p++;base=p;while(*p&&*p!='"'&&*p!=' '&&*p!='\t'){if(*p=='\\'||*p=='/')base=p+1;p++;}while(base<p&&n<(int)sizeof(name)-1)name[n++]=*base++;name[n]=0;return!stricmp(name,"bash.exe")||!stricmp(name,"bash");
}
static SHELL_SESSION *start_process(const char*command,const char*cwd,int direct) {
    SECURITY_ATTRIBUTES sa;HANDLE out_w=0,in_r=0,out_r_inherit=0,in_w_inherit=0,me;STARTUPINFOA si;PROCESS_INFORMATION pi;char*cmd;int i;
    for(i=0;i<MAX_SESSIONS&&sessions[i].used;i++);if(i==MAX_SESSIONS)return 0;
    memset(&sa,0,sizeof(sa));sa.nLength=sizeof(sa);sa.bInheritHandle=TRUE;
    if(!CreatePipe(&out_r_inherit,&out_w,&sa,0)||!CreatePipe(&in_r,&in_w_inherit,&sa,0))goto fail;
    me=GetCurrentProcess();
    if(!DuplicateHandle(me,out_r_inherit,me,&sessions[i].out_read,0,FALSE,DUPLICATE_SAME_ACCESS)||
       !DuplicateHandle(me,in_w_inherit,me,&sessions[i].in_write,0,FALSE,DUPLICATE_SAME_ACCESS))goto fail;
    CloseHandle(out_r_inherit);out_r_inherit=0;CloseHandle(in_w_inherit);in_w_inherit=0;
    memset(&si,0,sizeof(si));si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES|STARTF_USESHOWWINDOW;si.wShowWindow=SW_HIDE;
    si.hStdInput=in_r;si.hStdOutput=out_w;si.hStdError=out_w;
    if(command&&*command&&direct)cmd=_strdup(command);
    else if(command&&*command){const char*comspec=getenv("COMSPEC");if(!comspec||!*comspec)comspec="COMMAND.COM";cmd=(char*)malloc(strlen(comspec)+strlen(command)+6);if(cmd)sprintf(cmd,"\"%s\" /C %s",comspec,command);}
    else{const char*comspec=getenv("COMSPEC");cmd=_strdup(comspec&&*comspec?comspec:"COMMAND.COM");}
    if(!cmd)goto fail;
    sessions[i].replay=(unsigned char*)malloc(SHELL_REPLAY_BYTES);if(!sessions[i].replay){free(cmd);goto fail;}
    if(!CreateProcessA(0,cmd,0,0,TRUE,CREATE_NEW_PROCESS_GROUP,0,cwd&&*cwd?cwd:0,&si,&pi)){free(cmd);goto fail;}
    free(cmd);CloseHandle(out_w);CloseHandle(in_r);sessions[i].used=1;sessions[i].id=next_session++;sessions[i].pi=pi;return&sessions[i];
 fail: if(out_w)CloseHandle(out_w);if(in_r)CloseHandle(in_r);if(out_r_inherit)CloseHandle(out_r_inherit);if(in_w_inherit)CloseHandle(in_w_inherit);if(sessions[i].out_read)CloseHandle(sessions[i].out_read);if(sessions[i].in_write)CloseHandle(sessions[i].in_write);if(sessions[i].replay)free(sessions[i].replay);memset(&sessions[i],0,sizeof(sessions[i]));return 0;
}
static void replay_append(SHELL_SESSION*s,const unsigned char*data,unsigned long n) {
    unsigned long drop;
    if(!n)return;s->cursor+=n;
    if(n>=SHELL_REPLAY_BYTES){memcpy(s->replay,data+n-SHELL_REPLAY_BYTES,SHELL_REPLAY_BYTES);s->replay_len=SHELL_REPLAY_BYTES;s->replay_start=s->cursor-SHELL_REPLAY_BYTES;return;}
    if(s->replay_len+n>SHELL_REPLAY_BYTES){drop=s->replay_len+n-SHELL_REPLAY_BYTES;memmove(s->replay,s->replay+drop,s->replay_len-drop);s->replay_len-=drop;s->replay_start+=drop;}
    memcpy(s->replay+s->replay_len,data,n);s->replay_len+=n;
}
static unsigned long pump_session(SHELL_SESSION*s) {
    unsigned char temp[IO_CHUNK];DWORD avail=0,n=0;unsigned long total=0,take;
    for(;;){if(!PeekNamedPipe(s->out_read,0,0,0,&avail,0)||!avail)break;take=avail>IO_CHUNK?IO_CHUNK:avail;if(!ReadFile(s->out_read,temp,take,&n,0)||!n)break;replay_append(s,temp,n);total+=n;if(total>=SHELL_REPLAY_BYTES)break;}
    if(WaitForSingleObject(s->pi.hProcess,0)==WAIT_OBJECT_0){s->exited=1;GetExitCodeProcess(s->pi.hProcess,&s->exit_code);}return total;
}
static unsigned long replay_copy(SHELL_SESSION*s,unsigned long after,unsigned char*out,unsigned long cap) {
    unsigned long offset,n;if(after<s->replay_start||after>s->cursor)return 0;offset=after-s->replay_start;n=s->replay_len-offset;if(n>cap)n=cap;if(n)memcpy(out,s->replay+offset,n);return n;
}
static unsigned long read_session(SHELL_SESSION*s,unsigned char*out,unsigned long cap) {
    unsigned long before=s->cursor;pump_session(s);if(before<s->replay_start)before=s->replay_start;return replay_copy(s,before,out,cap);
}
static void close_session_handles(SHELL_SESSION*s) {
    if(!s||!s->used)return;
    CloseHandle(s->pi.hProcess);CloseHandle(s->pi.hThread);if(s->in_write)CloseHandle(s->in_write);if(s->out_read)CloseHandle(s->out_read);if(s->replay)free(s->replay);memset(s,0,sizeof(*s));
}

typedef struct{char*out;unsigned long cap,n;int visible_only;} JSON_ACC;
static BOOL CALLBACK enum_windows_cb(HWND h,LPARAM lp) {
    JSON_ACC*a=(JSON_ACC*)lp;char title[256],cls[128],et[1537],ec[769];RECT r;DWORD pid;int k,visible;
    visible=IsWindowVisible(h)!=0;if(a->visible_only&&!visible)return TRUE;GetWindowTextA(h,title,sizeof(title));GetClassNameA(h,cls,sizeof(cls));GetWindowRect(h,&r);GetWindowThreadProcessId(h,&pid);
    json_escape(title,et,sizeof(et));json_escape(cls,ec,sizeof(ec));k=_snprintf(a->out+a->n,a->cap-a->n,
      "%s{\"windowId\":%lu,\"title\":\"%s\",\"className\":\"%s\",\"processId\":%lu,\"visible\":%s,\"enabled\":%s,\"rect\":{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld}}",
      a->n?",":"",(unsigned long)h,et,ec,pid,visible?"true":"false",IsWindowEnabled(h)?"true":"false",r.left,r.top,r.right-r.left,r.bottom-r.top);
    if(k>0&&a->n+(unsigned long)k<a->cap)a->n+=k;return a->n+700<a->cap;
}

static void recursive_mkdir(char*p) {
    char*q=p;if(strlen(p)>2&&p[1]==':')q=p+3;for(;*q;q++)if(*q=='\\'||*q=='/'){char c=*q;*q=0;CreateDirectoryA(p,0);*q=c;}CreateDirectoryA(p,0);
}
static int delete_tree(const char*path) {
    WIN32_FIND_DATAA fd;HANDLE h;char pat[MAX_PATH],p[MAX_PATH];int ok=1;
    if(!path_pattern(path,pat))return 0;h=FindFirstFileA(pat,&fd);
    if(h!=INVALID_HANDLE_VALUE){do{if(strcmp(fd.cFileName,".")&&strcmp(fd.cFileName,"..")){
      if(!path_child(path,fd.cFileName,p)){ok=0;break;}
      if(fd.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY){if(!delete_tree(p))ok=0;}else if(!DeleteFileA(p))ok=0;
    }}while(ok&&FindNextFileA(h,&fd));FindClose(h);}return ok&&RemoveDirectoryA(path)!=0;
}

/* Toolhelp declarations are local so an old SDK can compile; functions are loaded. */
#define TH32CS_SNAPPROCESS 2
typedef struct {DWORD dwSize,cntUsage,th32ProcessID,th32DefaultHeapID,th32ModuleID,cntThreads,th32ParentProcessID;LONG pcPriClassBase;DWORD dwFlags;CHAR szExeFile[MAX_PATH];} W98_PROCESSENTRY32;
typedef HANDLE (WINAPI *PFN_SNAP)(DWORD,DWORD);
typedef BOOL (WINAPI *PFN_PFIRST)(HANDLE,W98_PROCESSENTRY32*);
typedef BOOL (WINAPI *PFN_PNEXT)(HANDLE,W98_PROCESSENTRY32*);
static void process_list_json(char*out,unsigned long cap) {
    HMODULE k=GetModuleHandleA("KERNEL32.DLL");PFN_SNAP snap=(PFN_SNAP)GetProcAddress(k,"CreateToolhelp32Snapshot");PFN_PFIRST first=(PFN_PFIRST)GetProcAddress(k,"Process32First");PFN_PNEXT next=(PFN_PNEXT)GetProcAddress(k,"Process32Next");
    HANDLE h;W98_PROCESSENTRY32 pe;unsigned long n=0;int z;char exe[MAX_PATH*6+1];if(!snap||!first||!next){strcpy(out,"[]");return;}h=snap(TH32CS_SNAPPROCESS,0);if(h==(HANDLE)-1){strcpy(out,"[]");return;}
    out[n++]='[';memset(&pe,0,sizeof(pe));pe.dwSize=sizeof(pe);if(first(h,&pe))do{json_escape(pe.szExeFile,exe,sizeof(exe));z=_snprintf(out+n,cap-n,"%s{\"processId\":%lu,\"parentProcessId\":%lu,\"executable\":\"%s\"}",n>1?",":"",pe.th32ProcessID,pe.th32ParentProcessID,exe);if(z<0||(unsigned long)z>=cap-n-2)break;n+=z;pe.dwSize=sizeof(pe);}while(next(h,&pe));out[n++]=']';out[n]=0;CloseHandle(h);
}

static int kill_process_tree(unsigned long pid,int tree) {
    HMODULE k=GetModuleHandleA("KERNEL32.DLL");PFN_SNAP snap;PFN_PFIRST first;PFN_PNEXT next;
    HANDLE shot,process;W98_PROCESSENTRY32 pe;unsigned long children[256];int count=0,i,ok=1;
    snap=(PFN_SNAP)GetProcAddress(k,"CreateToolhelp32Snapshot");first=(PFN_PFIRST)GetProcAddress(k,"Process32First");next=(PFN_PNEXT)GetProcAddress(k,"Process32Next");
    if(tree&&snap&&first&&next){shot=snap(TH32CS_SNAPPROCESS,0);if(shot!=(HANDLE)-1){memset(&pe,0,sizeof(pe));pe.dwSize=sizeof(pe);
      if(first(shot,&pe))do{if(pe.th32ParentProcessID==pid&&pe.th32ProcessID!=pid&&count<256)children[count++]=pe.th32ProcessID;pe.dwSize=sizeof(pe);}while(next(shot,&pe));CloseHandle(shot);
      for(i=0;i<count;i++)if(!kill_process_tree(children[i],1))ok=0;
    }}
    process=OpenProcess(PROCESS_TERMINATE,FALSE,pid);if(!process)return 0;
    if(!TerminateProcess(process,1))ok=0;CloseHandle(process);return ok;
}

static int process_descends_from(unsigned long candidate,unsigned long root) {
    HMODULE k=GetModuleHandleA("KERNEL32.DLL");PFN_SNAP snap;PFN_PFIRST first;PFN_PNEXT next;HANDLE shot;W98_PROCESSENTRY32 pe;
    unsigned long pids[512],parents[512],current;int count=0,i,depth;
    if(candidate==root)return 1;snap=(PFN_SNAP)GetProcAddress(k,"CreateToolhelp32Snapshot");first=(PFN_PFIRST)GetProcAddress(k,"Process32First");next=(PFN_PNEXT)GetProcAddress(k,"Process32Next");if(!snap||!first||!next)return 0;
    shot=snap(TH32CS_SNAPPROCESS,0);if(shot==(HANDLE)-1)return 0;memset(&pe,0,sizeof(pe));pe.dwSize=sizeof(pe);
    if(first(shot,&pe))do{if(count<512){pids[count]=pe.th32ProcessID;parents[count]=pe.th32ParentProcessID;count++;}pe.dwSize=sizeof(pe);}while(next(shot,&pe));CloseHandle(shot);
    current=candidate;for(depth=0;depth<64;depth++){for(i=0;i<count;i++)if(pids[i]==current)break;if(i==count||parents[i]==current||!parents[i])return 0;if(parents[i]==root)return 1;current=parents[i];}return 0;
}

typedef struct{unsigned long root_pid;HWND found;} MODAL_SEARCH;
static BOOL CALLBACK modal_window_cb(HWND h,LPARAM lp) {
    MODAL_SEARCH*m=(MODAL_SEARCH*)lp;DWORD pid=0;char cls[64];
    if(!IsWindowVisible(h)||!IsWindowEnabled(h))return TRUE;GetWindowThreadProcessId(h,&pid);if(!process_descends_from(pid,m->root_pid))return TRUE;
    cls[0]=0;GetClassNameA(h,cls,sizeof(cls));if(!strcmp(cls,"#32770")||GetWindow(h,GW_OWNER)){m->found=h;return FALSE;}return TRUE;
}
static HWND detect_modal_window(unsigned long root_pid) {
    MODAL_SEARCH m;m.root_pid=root_pid;m.found=0;EnumWindows(modal_window_cb,(LPARAM)&m);return m.found;
}

static int append_fs_entries(const char*root,const char*relative,int recursive,JSON_ACC*a) {
    WIN32_FIND_DATAA fd;HANDLE h;char pat[MAX_PATH],full[MAX_PATH],rel[MAX_PATH],escaped[MAX_PATH*6+1];int z;
    if(!path_pattern(root,pat))return 0;h=FindFirstFileA(pat,&fd);if(h==INVALID_HANDLE_VALUE)return 0;
    do{if(strcmp(fd.cFileName,".")&&strcmp(fd.cFileName,"..")){
      if(!path_child(root,fd.cFileName,full)){FindClose(h);return 0;}
      if(relative&&*relative){if(!path_child(relative,fd.cFileName,rel)){FindClose(h);return 0;}}else if(strlen(fd.cFileName)>=MAX_PATH){FindClose(h);return 0;}else strcpy(rel,fd.cFileName);
      if(a->n+2>=a->cap){FindClose(h);return 0;}json_escape(rel,escaped,sizeof(escaped));z=_snprintf(a->out+a->n,a->cap-a->n,
        "%s{\"name\":\"%s\",\"isDirectory\":%s,\"size\":%lu}",a->n>12?",":"",escaped,(fd.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)?"true":"false",fd.nFileSizeLow);
      if(z<0||(unsigned long)z>=a->cap-a->n-2){FindClose(h);return 0;}a->n+=(unsigned long)z;
      if(recursive&&(fd.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)&&!append_fs_entries(full,rel,1,a)){FindClose(h);return 0;}
    }}while(FindNextFileA(h,&fd));FindClose(h);return 1;
}

typedef struct{DWORD flags;DWORD delay_ms;} EXIT_JOB;
static DWORD WINAPI exit_windows_thread(LPVOID arg) {
    EXIT_JOB*job=(EXIT_JOB*)arg;DWORD flags=job->flags,delay=job->delay_ms;free(job);Sleep(delay);cleanup_input();
    if(!ExitWindowsEx(flags,0))log_line("ExitWindowsEx rejected the scheduled system action");return 0;
}
static char *schedule_system_exit(int reboot,int force,unsigned long delay_seconds) {
    DWORD flags=(reboot?EWX_REBOOT:EWX_SHUTDOWN)|(force?EWX_FORCE:0);HANDLE thread;EXIT_JOB*job;
    if(delay_seconds>604800UL)return error_result("INVALID_ARGUMENT","delay_seconds must be between zero and 604800");
    if(!delay_seconds){cleanup_input();if(!ExitWindowsEx(flags,0))return error_result("SYSTEM_ACTION_REJECTED","ExitWindowsEx rejected the request; close blocking applications or retry with force=true");return ok_data("{\"scheduled\":true,\"delaySeconds\":0}");}
    job=(EXIT_JOB*)malloc(sizeof(*job));if(!job)return error_result("OUT_OF_MEMORY","Cannot schedule system action");job->flags=flags;job->delay_ms=delay_seconds*1000UL;
    thread=CreateThread(0,0,exit_windows_thread,job,0,0);if(!thread){free(job);return error_result("SYSTEM_ACTION_REJECTED","Windows could not create the delayed shutdown worker");}CloseHandle(thread);return ok_data("{\"scheduled\":true}");
}

static char *ok_data(const char*data) {
    char*out=(char*)malloc(strlen(data)+80);if(out)sprintf(out,"{\"ok\":true,\"code\":\"OK\",\"message\":\"Success\",\"data\":%s}",data);return out;
}
static char *error_result(const char*code,const char*msg) {
    char em[512],*out;json_escape(msg,em,sizeof(em));out=(char*)malloc(strlen(code)+strlen(em)+100);if(out)sprintf(out,"{\"ok\":false,\"code\":\"%s\",\"message\":\"%s\"}",code,em);return out;
}
static char *error_data(const char*code,const char*msg,const char*data) {
    char em[512],*out;json_escape(msg,em,sizeof(em));out=(char*)malloc(strlen(code)+strlen(em)+strlen(data)+120);
    if(out)sprintf(out,"{\"ok\":false,\"code\":\"%s\",\"message\":\"%s\",\"data\":%s}",code,em,data);return out;
}
static char *string_error_result(const char*message) {
    if(json_string_error==2)return error_result("CHARACTER_NOT_REPRESENTABLE","Text cannot be represented in the active Windows ANSI code page");
    if(json_string_error==3)return error_result("STRING_TOO_LONG","Decoded string exceeds the Windows 98 field limit");
    return error_result("INVALID_ARGUMENT",message);
}

static char *dispatch(const char*method,const char*j) {
    char a[1024],b[256],*out,*enc;long x,y,x2,y2,n,i,timeout;int action;POINT pt;unsigned char*bin;unsigned long bin_n,written;HANDLE f;DWORD attr,size,got;SHELL_SESSION*s;FILE_TRANSFER*t;
    if(!strcmp(method,"vm_capabilities")||!strcmp(method,"system_info")){
      char guest[385];json_escape(cfg.guest_id,guest,sizeof(guest));sprintf(a,"{\"guestId\":\"%s\",\"guestBuildId\":\"%s\",\"protocolVersion\":1,\"osName\":\"Windows 98\",\"osVersion\":\"4.x\",\"ansiCodePage\":%u,\"oemCodePage\":%u,\"screenWidth\":%d,\"screenHeight\":%d,\"colorDepth\":%d,\"supportsLongFileNames\":true,\"supportsMouseWheel\":%s,\"maxPath\":260,\"maxFileBytes\":2147483647,\"uptimeMs\":%lu}",
        guest,BUILD_ID,GetACP(),GetOEMCP(),GetSystemMetrics(SM_CXSCREEN),GetSystemMetrics(SM_CYSCREEN),screen_color_depth(),GetSystemMetrics(SM_MOUSEWHEELPRESENT)?"true":"false",GetTickCount());return ok_data(a);
    }
    if(!strcmp(method,"system_reboot"))return schedule_system_exit(1,json_bool(j,"force",0),(unsigned long)json_long(j,"delay_seconds",0));
    if(!strcmp(method,"system_shutdown"))return schedule_system_exit(0,json_bool(j,"force",0),(unsigned long)json_long(j,"delay_seconds",0));
    if(!strcmp(method,"screen_capture")||!strcmp(method,"window_capture")){
      if(!strcmp(method,"window_capture")){RECT wr;HWND wh=(HWND)json_long(j,"window_id",0);if(!IsWindow(wh)||!GetWindowRect(wh,&wr))return error_result("WINDOW_NOT_FOUND","Window handle is invalid");x=wr.left;y=wr.top;x2=wr.right-wr.left;y2=wr.bottom-wr.top;}
      else{
      const char*region=json_value(j,"region");if(region&&*region=='{'){x=json_long(region,"x",0);y=json_long(region,"y",0);x2=json_long(region,"width",0);y2=json_long(region,"height",0);}
      else{x=json_long(j,"x",0);y=json_long(j,"y",0);x2=json_long(j,"width",0);y2=json_long(j,"height",0);}
      }
      bin=capture_bmp((int)x,(int)y,(int)x2,(int)y2,json_bool(j,"include_cursor",1),&bin_n);if(!bin)return error_result("SCREEN_CAPTURE_FAILED","GDI capture failed");
      GetCursorPos(&pt);
      if(bin_n<=700000UL){enc=base64_encode(bin,bin_n);free(bin);if(!enc)return error_result("OUT_OF_MEMORY","Encoding screenshot failed");
        out=(char*)malloc(strlen(enc)+384);sprintf(out,"{\"ok\":true,\"code\":\"OK\",\"message\":\"Success\",\"data\":{\"imageBase64\":\"%s\",\"mimeType\":\"image/bmp\",\"width\":%d,\"height\":%d,\"colorDepth\":%d,\"cursor\":{\"x\":%ld,\"y\":%ld}}}",enc,x2?x2:GetSystemMetrics(SM_CXSCREEN),y2?y2:GetSystemMetrics(SM_CYSCREEN),screen_color_depth(),pt.x,pt.y);free(enc);return out;}
      else{W98_SHA256_CTX hc;unsigned char hash[32];char hh[65];if(pending_binary)free(pending_binary);pending_binary=bin;pending_binary_len=bin_n;pending_binary_stream++;w98_sha256_init(&hc);w98_sha256_update(&hc,bin,bin_n);w98_sha256_final(&hc,hash);w98_hex(hash,32,hh);
        sprintf(a,"{\"binary\":{\"streamId\":%lu,\"totalBytes\":%lu,\"sha256\":\"%s\",\"mimeType\":\"image/bmp\"},\"width\":%d,\"height\":%d,\"colorDepth\":%d,\"cursor\":{\"x\":%ld,\"y\":%ld}}",pending_binary_stream,bin_n,hh,x2?x2:GetSystemMetrics(SM_CXSCREEN),y2?y2:GetSystemMetrics(SM_CYSCREEN),screen_color_depth(),pt.x,pt.y);return ok_data(a);}
    }
    if(!strncmp(method,"mouse_",6)){
      if(!strcmp(method,"mouse_position")){GetCursorPos(&pt);sprintf(a,"{\"x\":%ld,\"y\":%ld}",pt.x,pt.y);return ok_data(a);}
      if(!strcmp(method,"mouse_move")){POINT from;long duration=json_long(j,"duration_ms",0),steps;x=json_long(j,"x",-1);y=json_long(j,"y",-1);if(x<0||y<0||x>=GetSystemMetrics(SM_CXSCREEN)||y>=GetSystemMetrics(SM_CYSCREEN))return error_result("COORDINATE_OUT_OF_RANGE","Mouse coordinates are outside the primary screen");GetCursorPos(&from);steps=duration/20;if(steps<1)steps=1;for(i=1;i<=steps;i++){if(cooperative_stop()){cleanup_input();return error_result("OPERATION_CANCELLED","Mouse movement was cancelled");}move_pointer(from.x+(x-from.x)*i/steps,from.y+(y-from.y)*i/steps);if(duration&&!cooperative_sleep((unsigned long)(duration/steps))){cleanup_input();return error_result("OPERATION_CANCELLED","Mouse movement was cancelled");}}GetCursorPos(&pt);sprintf(a,"{\"x\":%ld,\"y\":%ld}",pt.x,pt.y);return ok_data(a);}
      b[0]=0;if(json_value(j,"button")&&!json_string(j,"button",b,sizeof(b)))return string_error_result("button is invalid");if(!b[0])strcpy(b,"left");x=json_long(j,"x",-1);y=json_long(j,"y",-1);if((x>=0)!=(y>=0))return error_result("INVALID_ARGUMENT","Mouse x and y must be supplied together");if(x>=0&&y>=0&&!move_pointer((int)x,(int)y))return error_result("COORDINATE_OUT_OF_RANGE","Mouse coordinates are outside the primary screen");
      if(!strcmp(method,"mouse_release_all")){cleanup_input();return ok_data("{}");}
      if(strcmp(b,"left")&&strcmp(b,"right")&&strcmp(b,"middle"))return error_result("INVALID_ARGUMENT","button must be left, right, or middle");
      if(!strcmp(method,"mouse_down")){mouse_event(button_flag(b,1),0,0,0,0);held_buttons|=button_bit(b);return ok_data("{}");}
      if(!strcmp(method,"mouse_up")){mouse_event(button_flag(b,0),0,0,0,0);held_buttons&=~button_bit(b);return ok_data("{}");}
      if(!strcmp(method,"mouse_click")){n=json_long(j,"click_count",1);if(n<1||n>10||json_long(j,"interval_ms",100)<0)return error_result("INVALID_ARGUMENT","click_count must be 1 through 10 and interval_ms must be nonnegative");for(i=0;i<n;i++){if(cooperative_stop())return error_result("OPERATION_CANCELLED","Mouse click was cancelled");mouse_event(button_flag(b,1),0,0,0,0);mouse_event(button_flag(b,0),0,0,0,0);if(i+1<n&&!cooperative_sleep((unsigned long)json_long(j,"interval_ms",100)))return error_result("OPERATION_CANCELLED","Mouse click was cancelled");}return ok_data("{}");}
      if(!strcmp(method,"mouse_scroll")){if(!GetSystemMetrics(SM_MOUSEWHEELPRESENT))return error_result("METHOD_UNSUPPORTED","The Windows 98 guest does not report a mouse wheel");mouse_event(0x0800,0,0,(DWORD)json_long(j,"delta",0),0);return ok_data("{}");}
      if(!strcmp(method,"mouse_drag")){int sw=GetSystemMetrics(SM_CXSCREEN),sh=GetSystemMetrics(SM_CYSCREEN);long duration=json_long(j,"duration_ms",500);x=json_long(j,"from_x",0);y=json_long(j,"from_y",0);x2=json_long(j,"to_x",0);y2=json_long(j,"to_y",0);n=json_long(j,"steps",20);if(x<0||y<0||x2<0||y2<0||x>=sw||x2>=sw||y>=sh||y2>=sh)return error_result("COORDINATE_OUT_OF_RANGE","Drag coordinates are outside the primary screen");if(n<1||n>1000||duration<0)return error_result("INVALID_ARGUMENT","steps must be 1 through 1000 and duration_ms must be nonnegative");if(!move_pointer(x,y))return error_result("MOUSE_MOVE_FAILED","Could not position pointer at drag start");mouse_event(button_flag(b,1),0,0,0,0);held_buttons|=button_bit(b);for(i=1;i<=n;i++){if(cooperative_stop()){cleanup_input();return error_result("OPERATION_CANCELLED","Mouse drag was cancelled");}if(!move_pointer(x+(x2-x)*i/n,y+(y2-y)*i/n)){cleanup_input();return error_result("MOUSE_MOVE_FAILED","Pointer movement failed during drag");}if(!cooperative_sleep((unsigned long)(duration/n))){cleanup_input();return error_result("OPERATION_CANCELLED","Mouse drag was cancelled");}}mouse_event(button_flag(b,0),0,0,0,0);held_buttons&=~button_bit(b);return ok_data("{}");}
    }
    if(!strncmp(method,"keyboard_",9)){
      if(!strcmp(method,"keyboard_release_all")){cleanup_input();return ok_data("{}");}
      if(!strcmp(method,"keyboard_type")){char*large=json_string_alloc(j,"text");if(!large)return string_error_result("text is required");action=type_text(large,json_long(j,"interval_ms",10));free(large);if(action<0)return error_result("OPERATION_CANCELLED","Keyboard typing was cancelled and held keys were released");if(!action)return error_result("CHARACTER_NOT_REPRESENTABLE","Text contains a character unavailable in the active keyboard layout");return ok_data("{}");}
      if(!strcmp(method,"keyboard_keycode")){x=json_long(j,"virtual_key",-1);y=json_long(j,"scan_code",0);b[0]=0;if(json_value(j,"action")&&!json_string(j,"action",b,sizeof(b)))return string_error_result("action is invalid");if(x<0&&y<=0)return error_result("INVALID_ARGUMENT","virtual_key or scan_code is required");if(x>255||y<0||y>255)return error_result("INVALID_ARGUMENT","virtual_key and scan_code must fit in one byte");if(b[0]&&strcmp(b,"down")&&strcmp(b,"up")&&strcmp(b,"press"))return error_result("INVALID_ARGUMENT","action must be down, up, or press");if(x<0)x=MapVirtualKeyA(y,1);action=!strcmp(b,"down")?1:!strcmp(b,"up")?0:2;if(action!=0)key_action(x,y,1,json_bool(j,"extended",0));if(action!=1)key_action(x,y,0,json_bool(j,"extended",0));return ok_data("{}");}
      if(!strcmp(method,"keyboard_hotkey")){if(!hotkey_array(j))return error_result("UNKNOWN_KEY","Hotkey contains an unknown key");return ok_data("{}");}
      if(!json_string(j,"key",a,sizeof(a)))return string_error_result("key is required");x=named_key(a);if(x<0)return error_result("UNKNOWN_KEY","Unknown named key");b[0]=0;if(json_value(j,"action")&&!json_string(j,"action",b,sizeof(b)))return string_error_result("action is invalid");if(b[0]&&strcmp(b,"down")&&strcmp(b,"up")&&strcmp(b,"press"))return error_result("INVALID_ARGUMENT","action must be down, up, or press");action=!strcmp(b,"down")?1:!strcmp(b,"up")?0:2;if(action)key_action(x,0,1,0);if(action!=1)key_action(x,0,0,0);return ok_data("{}");
    }
    if(!strcmp(method,"clipboard_get")){
      char*locked,*escaped;unsigned long escaped_cap;if(!OpenClipboard(0))return error_result("CLIPBOARD_BUSY","Cannot open clipboard");f=GetClipboardData(CF_TEXT);if(!f){CloseClipboard();return error_result("CLIPBOARD_EMPTY","CF_TEXT is not available");}locked=(char*)GlobalLock(f);if(!locked){CloseClipboard();return error_result("CLIPBOARD_READ_FAILED","GlobalLock failed");}escaped_cap=(unsigned long)strlen(locked)*6+1;escaped=(char*)malloc(escaped_cap);if(escaped)json_escape(locked,escaped,escaped_cap);GlobalUnlock(f);CloseClipboard();if(!escaped)return error_result("OUT_OF_MEMORY","Clipboard response allocation failed");out=(char*)malloc(strlen(escaped)+32);if(!out){free(escaped);return error_result("OUT_OF_MEMORY","Clipboard response allocation failed");}sprintf(out,"{\"text\":\"%s\"}",escaped);free(escaped);enc=ok_data(out);free(out);return enc;
    }
    if(!strcmp(method,"clipboard_set")){
      HGLOBAL hg;char*p,*large=json_string_alloc(j,"text");if(!large)return string_error_result("text is required");if(!OpenClipboard(0)){free(large);return error_result("CLIPBOARD_BUSY","Cannot open clipboard");}EmptyClipboard();hg=GlobalAlloc(GMEM_MOVEABLE|GMEM_DDESHARE,strlen(large)+1);if(!hg){free(large);CloseClipboard();return error_result("OUT_OF_MEMORY","Clipboard allocation failed");}p=(char*)GlobalLock(hg);if(!p){free(large);GlobalFree(hg);CloseClipboard();return error_result("CLIPBOARD_WRITE_FAILED","GlobalLock failed");}strcpy(p,large);free(large);GlobalUnlock(hg);if(!SetClipboardData(CF_TEXT,hg)){GlobalFree(hg);CloseClipboard();return error_result("CLIPBOARD_WRITE_FAILED","SetClipboardData failed");}CloseClipboard();return ok_data("{}");
    }
    if(!strcmp(method,"window_list")){out=(char*)malloc(65536);if(!out)return error_result("OUT_OF_MEMORY","Window list allocation failed");out[0]=0;{JSON_ACC ac;ac.out=out;ac.cap=65536;ac.n=0;ac.visible_only=json_bool(j,"visible_only",1);EnumWindows(enum_windows_cb,(LPARAM)&ac);memmove(out+12,out,ac.n+1);memcpy(out,"{\"windows\":[",12);strcat(out,"]}");}enc=ok_data(out);free(out);return enc;}
    if(!strcmp(method,"window_focus")){HWND h=(HWND)json_long(j,"window_id",0);if(!IsWindow(h))return error_result("WINDOW_NOT_FOUND","Window handle is invalid");ShowWindow(h,SW_RESTORE);SetForegroundWindow(h);return ok_data("{}");}
    if(!strcmp(method,"window_close")){HWND h=(HWND)json_long(j,"window_id",0);if(!PostMessageA(h,WM_CLOSE,0,0))return error_result("WINDOW_NOT_FOUND","Window handle is invalid");return ok_data("{}");}
    if(!strcmp(method,"shell_start")||!strcmp(method,"shell_exec")){
      if(!json_string(j,"command",a,sizeof(a))||!a[0])return string_error_result("command is required");
      b[0]=0;if(json_value(j,"cwd")&&!json_string(j,"cwd",b,sizeof(b)))return string_error_result("cwd is invalid");s=start_process(a,b,json_bool(j,"direct",command_is_direct_bash(a)));if(!s)return error_result("PROCESS_LAUNCH_FAILED","CreateProcessA failed");
      if(!strcmp(method,"shell_start")){sprintf(a,"{\"sessionId\":\"%lu\",\"processId\":%lu,\"running\":true}",s->id,s->pi.dwProcessId);return ok_data(a);}
      timeout=json_long(j,"timeout_ms",30000);if(timeout<0){TerminateProcess(s->pi.hProcess,1);WaitForSingleObject(s->pi.hProcess,5000);close_session_handles(s);return error_result("INVALID_ARGUMENT","timeout_ms must be nonnegative");}{unsigned char*buf=(unsigned char*)malloc(65536);unsigned long total=0,start=GetTickCount(),q,sid=s->id,pid=s->pi.dwProcessId,exitcode;char*text,shot[180];int timedout,needs_attention=0;HWND modal=0;
        if(!buf){TerminateProcess(s->pi.hProcess,1);WaitForSingleObject(s->pi.hProcess,5000);close_session_handles(s);return error_result("OUT_OF_MEMORY","Shell output allocation failed");}
        while(GetTickCount()-start<(unsigned long)timeout){if(cooperative_stop()){if(!control_aborted&&s->used){TerminateProcess(s->pi.hProcess,1);WaitForSingleObject(s->pi.hProcess,5000);close_session_handles(s);}free(buf);return error_result("OPERATION_CANCELLED","Command was cancelled and its process was terminated");}if(total<65535){q=read_session(s,buf+total,65535-total);total+=q;}else pump_session(s);if(s->exited)break;if((modal=detect_modal_window(pid))!=0){needs_attention=1;break;}if(!cooperative_sleep(20)){if(!control_aborted&&s->used){TerminateProcess(s->pi.hProcess,1);WaitForSingleObject(s->pi.hProcess,5000);close_session_handles(s);}free(buf);return error_result("OPERATION_CANCELLED","Command was cancelled and its process was terminated");}}
        timedout=!s->exited&&!needs_attention;if(timedout){TerminateProcess(s->pi.hProcess,1);WaitForSingleObject(s->pi.hProcess,5000);s->exited=1;GetExitCodeProcess(s->pi.hProcess,&s->exit_code);}exitcode=s->exit_code;shot[0]=0;
        if((needs_attention||timedout||exitcode!=0)&&json_bool(j,"screenshot_on_error",1))queue_full_screenshot(shot);buf[total]=0;enc=base64_encode(buf,total);text=ascii_escape_bytes(buf,total);free(buf);
        if(!enc||!text){free(enc);free(text);return error_result("OUT_OF_MEMORY","Shell result encoding failed");}
        out=(char*)malloc(strlen(enc)+strlen(text)+strlen(shot)+512);if(!out){free(enc);free(text);return error_result("OUT_OF_MEMORY","Shell response allocation failed");}
        sprintf(out,"{\"sessionId\":\"%lu\",\"processId\":%lu,\"exitCode\":%lu,\"timedOut\":%s,\"running\":%s,\"modalWindowId\":%lu,\"cursor\":%lu,\"outputTruncated\":%s,\"combined\":\"%s\",\"combinedBase64\":\"%s\",\"stream\":\"stdout+stderr\",\"encoding\":\"oem\"%s}",sid,pid,exitcode,timedout?"true":"false",needs_attention?"true":"false",(unsigned long)modal,s->cursor,s->cursor>total?"true":"false",text,enc,shot);free(text);free(enc);
        if(needs_attention){enc=error_data("NEEDS_ATTENTION","A process-owned modal window requires visual interaction.",out);free(out);return enc;}
        close_session_handles(s);
        if(timedout){enc=error_data("COMMAND_TIMEOUT","Command exceeded its timeout.",out);free(out);return enc;}
        if(exitcode!=0){enc=error_data("COMMAND_FAILED","Command exited with a nonzero status.",out);free(out);return enc;}
        enc=ok_data(out);free(out);return enc;}
    }
    if(!strncmp(method,"shell_",6)){s=find_session(json_id(j,"session_id",0));if(!s)return error_result("SESSION_NOT_FOUND","Shell session is not active");
      if(!strcmp(method,"shell_read")){unsigned char*buf;unsigned long started=GetTickCount(),wait=json_long(j,"wait_ms",0),after=json_long(j,"after_cursor",s->replay_start),limit=json_long(j,"max_bytes",IO_CHUNK);char*text;if(limit>65536UL)limit=65536UL;if(limit<1)limit=1;buf=(unsigned char*)malloc(limit);if(!buf)return error_result("OUT_OF_MEMORY","Shell read allocation failed");do{if(cooperative_stop()){free(buf);return error_result("OPERATION_CANCELLED","Shell read was cancelled");}pump_session(s);if(after<s->replay_start){free(buf);sprintf(a,"{\"earliestCursor\":%lu,\"latestCursor\":%lu}",s->replay_start,s->cursor);return error_data("CURSOR_EXPIRED","Requested shell output is no longer retained.",a);}if(after>s->cursor){free(buf);return error_result("CURSOR_INVALID","after_cursor is beyond the current stream cursor");}got=replay_copy(s,after,buf,limit);if(got||s->exited)break;if(!cooperative_sleep(20)){free(buf);return error_result("OPERATION_CANCELLED","Shell read was cancelled");}}while(GetTickCount()-started<wait);enc=base64_encode(buf,got);text=ascii_escape_bytes(buf,got);free(buf);if(!enc||!text){free(enc);free(text);return error_result("OUT_OF_MEMORY","Shell result encoding failed");}out=(char*)malloc(strlen(enc)+strlen(text)+240);if(!out){free(enc);free(text);return error_result("OUT_OF_MEMORY","Shell response allocation failed");}sprintf(out,"{\"sessionId\":\"%lu\",\"combinedBase64\":\"%s\",\"combined\":\"%s\",\"stream\":\"stdout+stderr\",\"encoding\":\"oem\",\"cursor\":%lu,\"latestCursor\":%lu,\"earliestCursor\":%lu,\"running\":%s,\"exitCode\":%lu}",s->id,enc,text,after+got,s->cursor,s->replay_start,s->exited?"false":"true",s->exit_code);free(text);free(enc);enc=ok_data(out);free(out);return enc;}
      if(!strcmp(method,"shell_write")){char*large;if(json_value(j,"base64")){large=json_string_alloc(j,"base64");if(!large)return string_error_result("base64 is invalid");bin=base64_decode(large,&bin_n);free(large);if(!bin)return error_result("INVALID_BASE64","Shell input is invalid");}else if(json_value(j,"text")){large=json_string_alloc(j,"text");if(!large)return string_error_result("text is invalid");bin=(unsigned char*)large;bin_n=strlen(large);}else{bin=(unsigned char*)_strdup("");bin_n=0;}if(!bin)return error_result("OUT_OF_MEMORY","Shell input allocation failed");if(bin_n&&(!s->in_write||!WriteFile(s->in_write,bin,bin_n,&written,0))){free(bin);return error_result("SHELL_WRITE_FAILED","Writing redirected stdin failed");}if(!bin_n)written=0;free(bin);if(json_bool(j,"eof",0)){if(s->in_write)CloseHandle(s->in_write);s->in_write=0;}sprintf(a,"{\"bytesWritten\":%lu}",written);return ok_data(a);}
      if(!strcmp(method,"shell_terminate")){if(!TerminateProcess(s->pi.hProcess,1))return error_result("SHELL_TERMINATE_FAILED","TerminateProcess failed");WaitForSingleObject(s->pi.hProcess,5000);s->exited=1;GetExitCodeProcess(s->pi.hProcess,&s->exit_code);sprintf(a,"{\"running\":false,\"exitCode\":%lu}",s->exit_code);return ok_data(a);}
      if(!strcmp(method,"shell_close")){pump_session(s);if(!s->exited)return error_result("SESSION_ACTIVE","Terminate the session before closing");close_session_handles(s);return ok_data("{}");}
    }
    if(!strcmp(method,"process_list")){out=(char*)malloc(65536);if(!out)return error_result("OUT_OF_MEMORY","Process list allocation failed");process_list_json(out,65536);enc=ok_data(out);free(out);return enc;}
    if(!strcmp(method,"process_kill")){return kill_process_tree((unsigned long)json_long(j,"process_id",0),json_bool(j,"tree",1))?ok_data("{}"):error_result("PROCESS_KILL_FAILED","Could not terminate the requested process tree");}
    if(!strcmp(method,"process_wait")){f=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_INFORMATION,FALSE,json_long(j,"process_id",0));if(!f)return error_result("PROCESS_NOT_FOUND","Cannot open process");timeout=json_long(j,"timeout_ms",0);action=WaitForSingleObject(f,timeout);GetExitCodeProcess(f,&size);CloseHandle(f);sprintf(a,"{\"exited\":%s,\"exitCode\":%lu}",action==WAIT_OBJECT_0?"true":"false",size);return ok_data(a);}
    if(!strcmp(method,"fs_stat")){char ep[MAX_PATH*6+1];if(!get_json_path(j,"path",a))return string_error_result("A valid path is required");attr=GetFileAttributesA(a);if(attr==0xffffffffUL)return error_result("PATH_NOT_FOUND","Path does not exist");f=CreateFileA(a,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,0,OPEN_EXISTING,0,0);size=f==INVALID_HANDLE_VALUE?0:GetFileSize(f,0);if(f!=INVALID_HANDLE_VALUE)CloseHandle(f);json_escape(a,ep,sizeof(ep));out=(char*)malloc(strlen(ep)+160);if(!out)return error_result("OUT_OF_MEMORY","Filesystem response allocation failed");sprintf(out,"{\"path\":\"%s\",\"isDirectory\":%s,\"size\":%lu,\"attributes\":%lu}",ep,(attr&FILE_ATTRIBUTE_DIRECTORY)?"true":"false",size,attr);enc=ok_data(out);free(out);return enc;}
    if(!strcmp(method,"fs_mkdir")){if(!get_json_path(j,"path",a))return string_error_result("A valid path is required");if(json_bool(j,"recursive",1))recursive_mkdir(a);else CreateDirectoryA(a,0);attr=GetFileAttributesA(a);return attr!=0xffffffffUL&&attr&FILE_ATTRIBUTE_DIRECTORY?ok_data("{}"):error_result("MKDIR_FAILED","Could not create directory");}
    if(!strcmp(method,"fs_move")){if(!get_json_path(j,"source",a))return string_error_result("A valid source path is required");if(!get_json_path(j,"destination",b))return string_error_result("A valid destination path is required");if(json_bool(j,"overwrite",0)){attr=GetFileAttributesA(b);if(attr!=0xffffffffUL){action=(attr&FILE_ATTRIBUTE_DIRECTORY)?RemoveDirectoryA(b):DeleteFileA(b);if(!action)return error_result("DESTINATION_NOT_REPLACEABLE","Existing destination could not be removed; non-empty directories are never recursively deleted by fs_move");}}return MoveFileA(a,b)?ok_data("{}"):error_result("MOVE_FAILED","MoveFileA failed");}
    if(!strcmp(method,"fs_delete")){if(!get_json_path(j,"path",a))return string_error_result("A valid path is required");attr=GetFileAttributesA(a);if(attr==0xffffffffUL)return error_result("PATH_NOT_FOUND","Path does not exist");action=(attr&FILE_ATTRIBUTE_DIRECTORY)?(json_bool(j,"recursive",0)?delete_tree(a):RemoveDirectoryA(a)):DeleteFileA(a);return action?ok_data("{}"):error_result("DELETE_FAILED","Delete failed");}
    if(!strcmp(method,"fs_list")){JSON_ACC ac;if(!get_json_path(j,"path",a))return string_error_result("A valid path is required");attr=GetFileAttributesA(a);if(attr==0xffffffffUL||!(attr&FILE_ATTRIBUTE_DIRECTORY))return error_result("PATH_NOT_FOUND","Directory does not exist");out=(char*)malloc(65536);if(!out)return error_result("OUT_OF_MEMORY","Directory list allocation failed");strcpy(out,"{\"entries\":[");ac.out=out;ac.cap=65536;ac.n=strlen(out);ac.visible_only=0;if(!append_fs_entries(a,"",json_bool(j,"recursive",0),&ac)){free(out);return error_result("FS_LIST_FAILED","Directory path is too long or the result exceeds 64 KiB");}strcat(out,"]}");enc=ok_data(out);free(out);return enc;}
    if(!strcmp(method,"file_read_chunk")){char file_sha[65];if(!get_json_path(j,"path",a))return string_error_result("A valid path is required");x=json_long(j,"offset",0);n=json_long(j,"length",FILE_CHUNK);if(x<0||n<1)return error_result("INVALID_ARGUMENT","offset and length must be nonnegative");if(n>(long)FILE_CHUNK)n=FILE_CHUNK;f=CreateFileA(a,GENERIC_READ,FILE_SHARE_READ,0,OPEN_EXISTING,0,0);if(f==INVALID_HANDLE_VALUE)return error_result("PATH_NOT_FOUND","File cannot be opened");size=GetFileSize(f,0);if((SetFilePointer(f,x,0,FILE_BEGIN)==0xffffffffUL&&GetLastError()!=NO_ERROR)){CloseHandle(f);return error_result("TRANSFER_READ_FAILED","Could not seek to requested file offset");}bin=(unsigned char*)malloc(n);if(!bin){CloseHandle(f);return error_result("OUT_OF_MEMORY","File chunk allocation failed");}if(!ReadFile(f,bin,n,&got,0)){free(bin);CloseHandle(f);return error_result("TRANSFER_READ_FAILED","Could not read file chunk");}file_sha[0]=0;if(x+got>=size)sha256_handle(f,file_sha);CloseHandle(f);enc=base64_encode(bin,got);free(bin);if(!enc)return error_result("OUT_OF_MEMORY","File chunk encoding failed");out=(char*)malloc(strlen(enc)+260);if(!out){free(enc);return error_result("OUT_OF_MEMORY","File response allocation failed");}sprintf(out,"{\"dataBase64\":\"%s\",\"offset\":%ld,\"nextOffset\":%ld,\"eof\":%s,\"size\":%lu%s%s%s}",enc,x,x+got,x+got>=size?"true":"false",size,file_sha[0]?",\"sha256\":\"":"",file_sha,file_sha[0]?"\"":"");free(enc);return ok_data(out);}
    if(!strcmp(method,"file_write_begin")){w98_u8 hash_check[32];int resume=0,meta_state;
      for(i=0;i<MAX_TRANSFERS&&transfers[i].used;i++);if(i==MAX_TRANSFERS)return error_result("TRANSFER_LIMIT","Too many active transfers");
      if(!json_string(j,"path",transfers[i].final_path,MAX_PATH))return string_error_result("A valid destination path is required");
      if(strlen(transfers[i].final_path)>MAX_PATH-9)return error_result("PATH_TOO_LONG","Destination leaves no room for resumable sibling files");
      for(n=0;n<MAX_TRANSFERS;n++)if(transfers[n].used&&!stricmp(transfers[n].final_path,transfers[i].final_path))return error_result("TRANSFER_ACTIVE","A transfer for this destination is already active");
      transfers[i].expected_size=json_long(j,"size",-1);transfers[i].expected_sha[0]=0;if(transfers[i].expected_size>2147483647UL||!json_string(j,"sha256",transfers[i].expected_sha,sizeof(transfers[i].expected_sha))||strlen(transfers[i].expected_sha)!=64||!w98_unhex(transfers[i].expected_sha,hash_check,32))return error_result("INVALID_ARGUMENT","size and a 64-character SHA-256 are required");
      if(_snprintf(transfers[i].temp_path,MAX_PATH,"%s.W98PART",transfers[i].final_path)<0||_snprintf(transfers[i].meta_path,MAX_PATH,"%s.W98META",transfers[i].final_path)<0)return error_result("PATH_TOO_LONG","Resumable transfer path is too long");
      transfers[i].id=next_transfer++;transfers[i].overwrite=json_bool(j,"overwrite",0);if(!transfers[i].overwrite&&GetFileAttributesA(transfers[i].final_path)!=0xffffffffUL)return error_result("ALREADY_EXISTS","Destination exists");
      meta_state=transfer_meta_state(&transfers[i]);if(meta_state<0)return error_result("TRANSFER_RESUME_CONFLICT","Resumable sibling files exist but are incomplete or are not owned by WIN98CTL");
      transfers[i].file=INVALID_HANDLE_VALUE;
      if(meta_state==1){transfers[i].file=CreateFileA(transfers[i].temp_path,GENERIC_READ|GENERIC_WRITE,0,0,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,0);if(transfers[i].file!=INVALID_HANDLE_VALUE&&rehash_transfer_prefix(&transfers[i]))resume=1;else{if(transfers[i].file!=INVALID_HANDLE_VALUE)CloseHandle(transfers[i].file);transfers[i].file=INVALID_HANDLE_VALUE;DeleteFileA(transfers[i].temp_path);DeleteFileA(transfers[i].meta_path);}}
      else if(meta_state==2){DeleteFileA(transfers[i].temp_path);DeleteFileA(transfers[i].meta_path);}
      if(!resume){transfers[i].file=CreateFileA(transfers[i].temp_path,GENERIC_READ|GENERIC_WRITE,0,0,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,0);if(transfers[i].file==INVALID_HANDLE_VALUE)return error_result("TRANSFER_OPEN_FAILED","Cannot create resumable temporary file");transfers[i].offset=0;w98_sha256_init(&transfers[i].sha);if(!write_transfer_meta(&transfers[i])){CloseHandle(transfers[i].file);DeleteFileA(transfers[i].temp_path);return error_result("TRANSFER_OPEN_FAILED","Cannot create resumable transfer metadata");}}
      transfers[i].used=1;sprintf(a,"{\"transferId\":\"%lu\",\"resumeOffset\":%lu}",transfers[i].id,transfers[i].offset);return ok_data(a);}
    if(!strncmp(method,"file_write_",11)){x=json_id(j,"transferId",0);for(i=0;i<MAX_TRANSFERS;i++)if(transfers[i].used&&transfers[i].id==(unsigned long)x)break;if(i==MAX_TRANSFERS)return error_result("TRANSFER_NOT_FOUND","Transfer is not active");t=&transfers[i];
      if(!strcmp(method,"file_write_chunk")){char*large;const char*crc_text;unsigned long expected_crc;y=json_long(j,"offset",-1);if((unsigned long)y!=t->offset)return error_result("OFFSET_MISMATCH","Chunk offset does not equal next offset");large=json_string_alloc(j,"dataBase64");if(!large)return error_result("INVALID_ARGUMENT","dataBase64 is required");bin=base64_decode(large,&bin_n);free(large);if(!bin)return error_result("INVALID_BASE64","Chunk data is invalid");if(bin_n>FILE_CHUNK){free(bin);return error_result("CHUNK_TOO_LARGE","Decoded chunk exceeds 65536 bytes");}crc_text=json_value(j,"crc32");expected_crc=crc_text?strtoul(*crc_text=='"'?crc_text+1:crc_text,0,10):0;if(crc_text&&crc32_bytes(bin,bin_n)!=expected_crc){free(bin);return error_result("CRC_MISMATCH","Chunk CRC32 did not match");}if(!WriteFile(t->file,bin,bin_n,&written,0)||written!=bin_n){free(bin);return error_result("TRANSFER_WRITE_FAILED","Writing chunk failed");}w98_sha256_update(&t->sha,bin,bin_n);free(bin);t->offset+=written;sprintf(a,"{\"nextOffset\":%lu}",t->offset);return ok_data(a);}
      if(!strcmp(method,"file_write_abort")){CloseHandle(t->file);memset(t,0,sizeof(*t));return ok_data("{\"preservedForResume\":true}");}
      if(!strcmp(method,"file_write_commit")){unsigned char digest[32];char actual[65],declared[65],meta[MAX_PATH];int overwrite=t->overwrite;strcpy(meta,t->meta_path);CloseHandle(t->file);if(t->offset!=t->expected_size){memset(t,0,sizeof(*t));return error_result("SIZE_MISMATCH","Transferred size does not match declaration; partial data was preserved");}w98_sha256_final(&t->sha,digest);w98_hex(digest,32,actual);declared[0]=0;json_string(j,"sha256",declared,sizeof(declared));if((t->expected_sha[0]&&stricmp(actual,t->expected_sha))||(declared[0]&&stricmp(actual,declared))){DeleteFileA(t->temp_path);DeleteFileA(t->meta_path);memset(t,0,sizeof(*t));return error_result("SHA256_MISMATCH","Transferred file hash did not match");}if(!overwrite&&GetFileAttributesA(t->final_path)!=0xffffffffUL){memset(t,0,sizeof(*t));return error_result("ALREADY_EXISTS","Destination was created during transfer; partial data was preserved");}if(overwrite)DeleteFileA(t->final_path);action=MoveFileA(t->temp_path,t->final_path);memset(t,0,sizeof(*t));if(action)DeleteFileA(meta);return action?ok_data("{}"):error_result("TRANSFER_COMMIT_FAILED","Atomic sibling rename failed; partial data was preserved");}
    }
    if(!strcmp(method,"sanitize")||!strcmp(method,"session_abort")){cleanup_input();cleanup_sessions();cleanup_transfers();return ok_data("{\"sanitized\":true}");}
    if(!strcmp(method,"input_batch")){
      const char*p=json_value(j,"actions"),*start,*end;char obj[2048],typ[80];int depth,completed=0;char*one;
      if(!p||*p!='[')return error_result("INVALID_ARGUMENT","actions array is required");p++;
      while(*p){int quoted=0,escaped=0;while(*p&&*p!='{'&&*p!=']')p++;if(*p==']')break;start=p;depth=0;do{if(escaped)escaped=0;else if(*p=='\\'&&quoted)escaped=1;else if(*p=='"')quoted=!quoted;else if(!quoted&&*p=='{')depth++;else if(!quoted&&*p=='}')depth--;p++;}while(*p&&depth);end=p;if((unsigned long)(end-start)>=sizeof(obj)){cleanup_input();return error_result("BATCH_ACTION_TOO_LARGE","Batch action exceeds guest limit");}memcpy(obj,start,end-start);obj[end-start]=0;
        if(!json_string(obj,"type",typ,sizeof(typ))){cleanup_input();return error_result("INVALID_ARGUMENT","Batch action has no type");}
        if(!strcmp(typ,"delay")){if(!cooperative_sleep((unsigned long)json_long(obj,"milliseconds",0))){cleanup_input();return error_result("OPERATION_CANCELLED","Input batch delay was cancelled");}completed++;continue;}one=dispatch(typ,obj);
        if(!one||strstr(one,"\"ok\":false")){cleanup_input();if(!json_bool(j,"stop_on_error",1)){if(one)free(one);continue;}if(one)return one;return error_result("OUT_OF_MEMORY","Batch action failed");}free(one);completed++;
      }if(json_bool(j,"screenshot_after",0))return dispatch("screen_capture","{\"include_cursor\":true}");sprintf(a,"{\"completed\":%d}",completed);return ok_data(a);
    }
    return error_result("METHOD_NOT_FOUND","Guest does not implement this method");
}

/* The broker requires a single JSON object containing kind/requestId plus the
 * operation result fields.  Never splice an arbitrary or empty object after a
 * trailing comma: that emits malformed JSON and makes a write operation's
 * outcome unknowable to the host. */
static int result_is_response_object(const char*result) {
    unsigned long n;
    if(!result)return 0;
    n=strlen(result);
    return n>2&&result[0]=='{'&&result[n-1]=='}'&&strstr(result,"\"ok\":")&&strstr(result,"\"code\":")&&strstr(result,"\"message\":");
}
static char* build_response_json(const char*method,const char*request_id,const char*result) {
    static const char fallback[]="{\"ok\":false,\"code\":\"RESPONSE_CONSTRUCTION_FAILED\",\"message\":\"Guest rejected an invalid internal response\",\"data\":{}}";
    char escaped[256],line[320],*response;const char*safe=result;unsigned long n,first,last,cap;
    n=safe?(unsigned long)strlen(safe):0;first=n?(unsigned char)safe[0]:0;last=n?(unsigned char)safe[n-1]:0;
    if(!result_is_response_object(safe))safe=fallback;
    _snprintf(line,sizeof(line),"response method=%s len=%lu first=%02lX last=%02lX valid=%s",method&&method[0]?method:"?",n,first,last,safe==result?"yes":"no");line[sizeof(line)-1]=0;log_line(line);
    json_escape(request_id?request_id:"",escaped,sizeof(escaped));cap=(unsigned long)strlen(safe)+(unsigned long)strlen(escaped)+80;
    response=(char*)malloc(cap);if(!response)return 0;
    if(_snprintf(response,cap,"{\"kind\":\"response\",\"requestId\":\"%s\",%s",escaped,safe+1)<0){free(response);return 0;}
    return response;
}
static int send_cooperative_response(unsigned long stream,const char*method,const char*request_id,const char*result) {
    char*response=build_response_json(method,request_id,result);int ok;
    if(!response)return 0;
    ok=w98_send_frame(control_socket,W98_F_RESPONSE,0,stream,control_tx_sequence++,0,response,strlen(response),control_key,"guest-to-host");free(response);return ok;
}
static int cooperative_stop(void) {
    int ready;W98_FRAME f;w98_u8*payload,mac[32];char method[128],rid[128];char*result;
    if(agent_stop_requested()){control_aborted=1;return 1;}
    if(control_socket==INVALID_SOCKET)return 0;
    for(;;){ready=w98_frame_ready(control_socket);if(ready<0){control_dead=1;break;}if(!ready)break;
      if(!w98_recv_frame(control_socket,&f,&payload,mac)){control_dead=1;break;}
      if(f.seq_hi||f.seq_lo!=control_rx_sequence++||!w98_verify_frame(&f,payload,mac,control_key,"host-to-guest")){free(payload);control_dead=1;break;}
      if(f.type==W98_F_PING){if(!w98_send_frame(control_socket,W98_F_PONG,0,f.stream_id,control_tx_sequence++,0,payload,f.payload_len,control_key,"guest-to-host"))control_dead=1;free(payload);continue;}
      if(f.type==W98_F_CANCEL){control_cancelled=1;free(payload);continue;}
      if(f.type==W98_F_REQUEST){method[0]=rid[0]=0;json_string((char*)payload,"method",method,sizeof(method));json_string((char*)payload,"requestId",rid,sizeof(rid));
        if(!strcmp(method,"session_abort")||!strcmp(method,"sanitize")){control_aborted=1;cleanup_input();cleanup_sessions();cleanup_transfers();result=ok_data("{\"sanitized\":true}");}
        else result=error_result("VM_BUSY","A guest operation is already in progress");
        free(payload);if(!send_cooperative_response(f.stream_id,method,rid,result)){free(result);control_dead=1;break;}free(result);continue;
      }
      free(payload);
    }
    return control_dead||control_cancelled||control_aborted;
}
static int cooperative_sleep(unsigned long milliseconds) {
    unsigned long start=GetTickCount(),elapsed;do{if(cooperative_stop())return 0;elapsed=GetTickCount()-start;if(elapsed>=milliseconds)break;Sleep(milliseconds-elapsed>20?20:milliseconds-elapsed);}while(1);return !cooperative_stop();
}

static void random_bytes(w98_u8*out,int n) {
    HCRYPTPROV p=0;typedef BOOL(WINAPI*PFN_ACQ)(HCRYPTPROV*,LPCSTR,LPCSTR,DWORD,DWORD);typedef BOOL(WINAPI*PFN_GEN)(HCRYPTPROV,DWORD,BYTE*);typedef BOOL(WINAPI*PFN_REL)(HCRYPTPROV,DWORD);
    HMODULE a=LoadLibraryA("ADVAPI32.DLL");PFN_ACQ acq;PFN_GEN gen;PFN_REL rel;int i;
    if(a){acq=(PFN_ACQ)GetProcAddress(a,"CryptAcquireContextA");gen=(PFN_GEN)GetProcAddress(a,"CryptGenRandom");rel=(PFN_REL)GetProcAddress(a,"CryptReleaseContext");
      if(acq&&gen&&rel&&acq(&p,0,0,1,0xf0000000UL)&&gen(p,n,out)){rel(p,0);FreeLibrary(a);return;}if(p)rel(p,0);FreeLibrary(a);}
    srand((unsigned int)(GetTickCount()^GetCurrentProcessId()));for(i=0;i<n;i++)out[i]=(w98_u8)(rand()^(GetTickCount()>>(i&7)));
}
static int parse_proof(const char*j,char*out){return json_string(j,"proof",out,65);}

/*
 * Stream the frame through blocking recv() calls. Requiring a complete 64 KiB
 * frame to be present in FIONREAD deadlocks against Windows 98's smaller TCP
 * receive buffer. SO_RCVTIMEO still breaks a genuinely idle/half-open socket.
 */
static int receive_frame_with_timeout(SOCKET s,W98_FRAME*f,w98_u8**payload,w98_u8 mac[32],unsigned long timeout) {
    int timeout_ms=(int)timeout;if(agent_stop_requested())return 0;
    setsockopt(s,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout_ms,sizeof(timeout_ms));return w98_recv_frame(s,f,payload,mac);
}
static void log_winsock_error(const char*message) {
    char line[160];sprintf(line,"%s (Winsock error %d)",message,WSAGetLastError());log_line(line);
}

static int authenticated_loop(SOCKET s) {
    w98_u8 gn[32],hn[32],key[32],proof[32],mac[32],*payload,*raw;char *b64,*proof64,htext[80],json[4096],rid[128],method[128],guest_text[385],*result,*resp;const char*wheel_command;W98_FRAME f;unsigned long off,chunk;int was_authenticated=0;
    json_escape(cfg.guest_id,guest_text,sizeof(guest_text));random_bytes(gn,32);b64=base64_encode(gn,32);if(!b64)return 0;sprintf(json,"{\"kind\":\"guest_hello\",\"guestNonce\":\"%s\",\"guestId\":\"%s\",\"guestBuildId\":\"%s\"}",b64,guest_text,BUILD_ID);free(b64);
    if(!w98_send_frame(s,W98_F_HELLO,0,0,0,0,json,strlen(json),0,0)||!receive_frame_with_timeout(s,&f,&payload,mac,HANDSHAKE_TIMEOUT_MS))return 0;
    if(f.type!=W98_F_CHALLENGE||!json_string((char*)payload,"hostNonce",htext,sizeof(htext))){free(payload);return 0;}
    raw=base64_decode(htext,&off);if(!raw||off!=32){free(raw);free(payload);return 0;}memcpy(hn,raw,32);free(raw);
    w98_hmac_sha256(cfg.psk,cfg.psk_len,"session-key\0",12,gn,32,hn,32,key);
    if(!parse_proof((char*)payload,htext)){free(payload);return 0;}raw=base64_decode(htext,&off);w98_hmac_sha256(key,32,"host-proof\0",11,0,0,0,0,proof);
    if(!raw||off!=32||memcmp(raw,proof,32)){free(raw);free(payload);log_line("host proof rejected");return 0;}free(raw);free(payload);
    w98_hmac_sha256(key,32,"guest-proof\0",12,0,0,0,0,proof);proof64=base64_encode(proof,32);if(!proof64)return 0;
    wheel_command=GetSystemMetrics(SM_MOUSEWHEELPRESENT)?"\"mouse_scroll\",":"";
    sprintf(json,"{\"kind\":\"authenticate\",\"proof\":\"%s\",\"capabilities\":{\"guestId\":\"%s\",\"guestBuildId\":\"%s\",\"protocolVersion\":1,\"osName\":\"Windows 98\",\"osVersion\":\"4.x\",\"ansiCodePage\":%u,\"oemCodePage\":%u,\"screenWidth\":%d,\"screenHeight\":%d,\"colorDepth\":%d,\"supportsLongFileNames\":true,\"supportsMouseWheel\":%s,\"maxPath\":260,\"maxFileBytes\":2147483647,\"commands\":[\"screen_capture\",\"mouse_move\",\"mouse_click\",\"mouse_down\",\"mouse_up\",\"mouse_drag\",%s\"mouse_position\",\"mouse_release_all\",\"keyboard_type\",\"keyboard_key\",\"keyboard_hotkey\",\"keyboard_keycode\",\"keyboard_release_all\",\"input_batch\",\"clipboard_get\",\"clipboard_set\",\"window_list\",\"window_focus\",\"window_close\",\"window_capture\",\"shell_exec\",\"shell_start\",\"shell_read\",\"shell_write\",\"shell_terminate\",\"shell_close\",\"process_list\",\"process_wait\",\"process_kill\",\"fs_stat\",\"fs_list\",\"fs_mkdir\",\"fs_move\",\"fs_delete\",\"file_read_chunk\",\"file_write_begin\",\"file_write_chunk\",\"file_write_commit\",\"file_write_abort\",\"system_info\",\"system_reboot\",\"system_shutdown\",\"session_abort\",\"sanitize\"]}}",
      proof64,guest_text,BUILD_ID,GetACP(),GetOEMCP(),GetSystemMetrics(SM_CXSCREEN),GetSystemMetrics(SM_CYSCREEN),screen_color_depth(),GetSystemMetrics(SM_MOUSEWHEELPRESENT)?"true":"false",wheel_command);free(proof64);
    if(!w98_send_frame(s,W98_F_AUTHENTICATE,0,0,0,0,json,strlen(json),0,0)||!receive_frame_with_timeout(s,&f,&payload,mac,HANDSHAKE_TIMEOUT_MS))return 0;
    if(f.type!=W98_F_AUTHENTICATED||f.seq_lo!=1||!w98_verify_frame(&f,payload,mac,key,"host-to-guest")){free(payload);return 0;}free(payload);
    was_authenticated=1;log_line("authenticated");set_agent_status("Connected and authenticated");control_socket=s;memcpy(control_key,key,32);control_tx_sequence=1;control_rx_sequence=2;control_cancelled=control_aborted=control_dead=0;
    for(;;){if(!receive_frame_with_timeout(s,&f,&payload,mac,CONTROL_IDLE_TIMEOUT_MS)){log_line("connection idle timeout or socket closed");break;}if(f.seq_hi||f.seq_lo!=control_rx_sequence++||!w98_verify_frame(&f,payload,mac,key,"host-to-guest")){free(payload);log_line("signed frame validation failed");break;}
      if(f.type==W98_F_PING){w98_send_frame(s,W98_F_PONG,0,0,control_tx_sequence++,0,payload,f.payload_len,key,"guest-to-host");free(payload);continue;}
      if(f.type!=W98_F_REQUEST){free(payload);continue;}control_cancelled=control_aborted=0;rid[0]=method[0]=0;json_string((char*)payload,"requestId",rid,sizeof(rid));json_string((char*)payload,"method",method,sizeof(method));result=dispatch(method,(char*)payload);free(payload);if(result&&strstr(result,"\"ok\":false"))cleanup_input();
      if(pending_binary){for(off=0;off<pending_binary_len;off+=chunk){chunk=pending_binary_len-off;if(chunk>W98_MAX_DATA)chunk=W98_MAX_DATA;if(!w98_send_frame(s,W98_F_DATA,(off+chunk==pending_binary_len)?1:0,pending_binary_stream,control_tx_sequence++,0,pending_binary+off,chunk,key,"guest-to-host")){free(pending_binary);pending_binary=0;goto connection_end;}}free(pending_binary);pending_binary=0;pending_binary_len=0;}
      if(!result)result=error_result("OUT_OF_MEMORY","Guest could not allocate an operation result");if(!result)break;
      resp=build_response_json(method,rid,result);free(result);if(!resp)break;
      if(!w98_send_frame(s,W98_F_RESPONSE,0,f.stream_id,control_tx_sequence++,0,resp,strlen(resp),key,"guest-to-host")){free(resp);break;}free(resp);
    }
connection_end:
    control_socket=INVALID_SOCKET;memset(control_key,0,sizeof(control_key));memset(key,0,sizeof(key));cleanup_input();
    if(agent_stop_requested()){log_line("connection ended during shutdown");set_agent_status("Stopping...");}
    else{log_line("connection ended; reconnecting");set_agent_status("Connection lost; reconnecting");}
    return was_authenticated;
}

static int load_config(void) {
    char exe[MAX_PATH],dir[MAX_PATH],pskhex[129];char*p;unsigned long hex_len,exe_len;exe[0]=0;exe_len=GetModuleFileNameA(0,exe,sizeof(exe));if(!exe_len||exe_len>=sizeof(exe))return 0;strcpy(dir,exe);p=strrchr(dir,'\\');if(p)*p=0;
    if(!safe_format(cfg.ini_path,MAX_PATH,"%s\\WIN98CTL.INI",dir,0)||!safe_format(cfg.log_path,MAX_PATH,"%s\\MCPAGENT.LOG",dir,0)){MessageBoxA(0,"WIN98CTL is installed in a path that is too long.","WIN98CTL configuration error",MB_ICONERROR);return 0;}
    GetPrivateProfileStringA("connection","host","192.168.56.1",cfg.host,sizeof(cfg.host),cfg.ini_path);cfg.port=(unsigned short)GetPrivateProfileIntA("connection","port",9898,cfg.ini_path);
    GetPrivateProfileStringA("identity","guest_id","win98-vm",cfg.guest_id,sizeof(cfg.guest_id),cfg.ini_path);GetPrivateProfileStringA("security","psk_hex","",pskhex,sizeof(pskhex),cfg.ini_path);
    hex_len=strlen(pskhex);cfg.psk_len=hex_len/2;if(hex_len<64||hex_len>128||(hex_len&1)||!w98_unhex(pskhex,cfg.psk,cfg.psk_len)){MessageBoxA(0,"Set a PSK of at least 32 bytes as hexadecimal psk_hex in WIN98CTL.INI.","WIN98CTL configuration error",MB_ICONERROR);return 0;}return 1;
}
static int install_startup(void) {
    HKEY k;char exe[MAX_PATH],value[MAX_PATH+3];LONG r;unsigned long exe_len;exe_len=GetModuleFileNameA(0,exe,sizeof(exe));if(!exe_len||exe_len>=sizeof(exe))return 0;if(_snprintf(value,sizeof(value),"\"%s\"",exe)<0)return 0;r=RegOpenKeyExA(HKEY_CURRENT_USER,"Software\\Microsoft\\Windows\\CurrentVersion\\Run",0,KEY_SET_VALUE,&k);
    if(r==ERROR_SUCCESS){r=RegSetValueExA(k,"WIN98CTL",0,REG_SZ,(BYTE*)value,strlen(value)+1);RegCloseKey(k);}return r==ERROR_SUCCESS;
}
static int self_test(void) {
    WSADATA wd;char path[MAX_PATH],dir[MAX_PATH],temp[MAX_PATH],*slash,hx[65];FILE*f,*tf;unsigned char*d,digest[32],pipebuf[1024];unsigned long n,total,start;volatile unsigned long reconnect_delay;int ok=1;SHELL_SESSION*s;
    strcpy(dir,cfg.ini_path);slash=strrchr(dir,'\\');if(slash)*slash=0;if(!safe_format(path,MAX_PATH,"%s\\SELFTEST.TXT",dir,0))return 2;f=fopen(path,"w");if(!f)return 2;
    reconnect_delay=RECONNECT_DELAY_MS;fprintf(f,"WIN98CTL %s SELF TEST\r\n",BUILD_ID);fprintf(f,"Configuration: PASS\r\n");fprintf(f,"Reconnect interval: %s (%lu ms)\r\n",reconnect_delay==2000UL?"PASS":"FAIL",reconnect_delay);if(reconnect_delay!=2000UL)ok=0;if(WSAStartup(MAKEWORD(2,0),&wd)){fprintf(f,"Winsock 2: FAIL (WSAStartup rejected version 2.0)\r\n");ok=0;}else{if(LOBYTE(wd.wVersion)<2){fprintf(f,"Winsock 2: FAIL (provider returned version %u.%u)\r\n",LOBYTE(wd.wVersion),HIBYTE(wd.wVersion));ok=0;}else fprintf(f,"Winsock 2: PASS %u.%u (%s)\r\n",LOBYTE(wd.wVersion),HIBYTE(wd.wVersion),wd.szDescription);WSACleanup();}
    d=capture_bmp(0,0,64,64,0,&n);fprintf(f,"GDI capture: %s (%lu bytes)\r\n",d?"PASS":"FAIL",d?n:0);if(!d)ok=0;free(d);
    w98_hmac_sha256((w98_u8*)"key",3,"The quick brown fox jumps over the lazy dog",43,0,0,0,0,digest);w98_hex(digest,32,hx);
    fprintf(f,"HMAC-SHA256: %s\r\n",!strcmp(hx,"f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8")?"PASS":"FAIL");
    if(strcmp(hx,"f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"))ok=0;
    fprintf(f,"Keyboard APIs: %s\r\n",GetProcAddress(GetModuleHandleA("USER32.DLL"),"keybd_event")?"PASS":"FAIL");
    if(!safe_format(temp,MAX_PATH,"%s\\W98TEST.TMP",dir,0)){fprintf(f,"Temporary file: FAIL (path)\r\n");ok=0;}
    else{tf=fopen(temp,"wb");if(tf){fwrite("WIN98CTL",1,8,tf);fclose(tf);}tf=fopen(temp,"rb");memset(pipebuf,0,sizeof(pipebuf));n=tf?fread(pipebuf,1,8,tf):0;if(tf)fclose(tf);DeleteFileA(temp);fprintf(f,"Temporary file: %s\r\n",n==8&&!memcmp(pipebuf,"WIN98CTL",8)?"PASS":"FAIL");if(n!=8||memcmp(pipebuf,"WIN98CTL",8))ok=0;}
    memset(pipebuf,0,sizeof(pipebuf));s=start_process("ECHO WIN98CTL_SELFTEST",dir,0);total=0;start=GetTickCount();if(s){while(GetTickCount()-start<5000&&total<sizeof(pipebuf)-1){total+=read_session(s,pipebuf+total,sizeof(pipebuf)-1-total);if(s->exited)break;Sleep(20);}pipebuf[total]=0;if(!s->exited)TerminateProcess(s->pi.hProcess,1);}
    fprintf(f,"COMMAND.COM echo: %s\r\n",s&&strstr((char*)pipebuf,"WIN98CTL_SELFTEST")?"PASS":"FAIL");if(!s||!strstr((char*)pipebuf,"WIN98CTL_SELFTEST"))ok=0;if(s)close_session_handles(s);
    fprintf(f,"Result: %s\r\n",ok?"PASS":"FAIL");fclose(f);return ok?0:1;
}

static DWORD WINAPI agent_network_thread(LPVOID parameter) {
    WSADATA wd;SOCKET s;struct sockaddr_in sa;struct hostent*he;int startup_result,keepalive=1,socket_timeout=(int)CONTROL_IDLE_TIMEOUT_MS,winsock_started=0;char line[192];
    (void)parameter;
    for(;;){if(agent_stop_requested())goto network_done;startup_result=WSAStartup(MAKEWORD(2,0),&wd);if(!startup_result&&LOBYTE(wd.wVersion)>=2){winsock_started=1;break;}if(!startup_result)WSACleanup();log_line("Winsock 2 is unavailable; retrying initialization in 2 seconds");set_agent_status("Winsock 2 unavailable; retrying in 2 seconds...");if(wait_for_agent_stop(RECONNECT_DELAY_MS))goto network_done;}
    log_line("agent starting with persistent 2-second reconnect enabled");
    for(;;){if(agent_stop_requested())break;s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(s!=INVALID_SOCKET){set_agent_socket(s);setsockopt(s,SOL_SOCKET,SO_KEEPALIVE,(char*)&keepalive,sizeof(keepalive));setsockopt(s,SOL_SOCKET,SO_RCVTIMEO,(char*)&socket_timeout,sizeof(socket_timeout));setsockopt(s,SOL_SOCKET,SO_SNDTIMEO,(char*)&socket_timeout,sizeof(socket_timeout));memset(&sa,0,sizeof(sa));sa.sin_family=AF_INET;sa.sin_port=htons(cfg.port);sa.sin_addr.s_addr=inet_addr(cfg.host);
      sprintf(line,"Connecting to %s:%u...",cfg.host,(unsigned int)cfg.port);set_agent_status(line);
      if(sa.sin_addr.s_addr==INADDR_NONE){he=gethostbyname(cfg.host);if(he)memcpy(&sa.sin_addr,he->h_addr,he->h_length);else log_winsock_error("host name resolution failed");}
      if(!agent_stop_requested()&&connect(s,(struct sockaddr*)&sa,sizeof(sa))==0){log_line("TCP connected");set_agent_status("TCP connected; authenticating...");authenticated_loop(s);}else if(!agent_stop_requested())log_winsock_error("TCP connect failed");close_agent_socket(s);}else log_winsock_error("socket creation failed");
      cleanup_input();cleanup_sessions();cleanup_transfers();if(agent_stop_requested())break;set_agent_status("Disconnected; retrying in 2 seconds");log_line("reconnect scheduled in 2000 milliseconds");if(wait_for_agent_stop(RECONNECT_DELAY_MS))break;}
network_done:
    interrupt_agent_socket();control_socket=INVALID_SOCKET;cleanup_input();cleanup_sessions();cleanup_transfers();if(winsock_started)WSACleanup();log_line("agent stopped");set_agent_status("Stopped");if(agent_main_window)PostMessageA(agent_main_window,WM_AGENT_WORKER_DONE,0,0);return 0;
}

static void begin_agent_shutdown(HWND hwnd) {
    if(agent_ui_stopping)return;agent_ui_stopping=1;if(agent_status_window)SetWindowTextA(agent_status_window,"Stopping...");if(agent_close_button)EnableWindow(agent_close_button,FALSE);if(agent_stop_event)SetEvent(agent_stop_event);interrupt_agent_socket();
    if(!agent_worker_thread)DestroyWindow(hwnd);
}

static LRESULT CALLBACK agent_window_proc(HWND hwnd,UINT message,WPARAM wparam,LPARAM lparam) {
    char status[256];
    (void)lparam;
    if(message==WM_COMMAND&&LOWORD(wparam)==ID_CLOSE_BUTTON){begin_agent_shutdown(hwnd);return 0;}
    if(message==WM_CLOSE){begin_agent_shutdown(hwnd);return 0;}
    if(message==WM_AGENT_STATUS){if(!agent_ui_stopping&&agent_status_window){EnterCriticalSection(&agent_status_lock);strcpy(status,agent_status_text);LeaveCriticalSection(&agent_status_lock);SetWindowTextA(agent_status_window,status);}return 0;}
    if(message==WM_AGENT_WORKER_DONE){DestroyWindow(hwnd);return 0;}
    if(message==WM_QUERYENDSESSION)return TRUE;
    if(message==WM_ENDSESSION&&wparam){begin_agent_shutdown(hwnd);return 0;}
    if(message==WM_DESTROY){agent_main_window=0;PostQuitMessage(0);return 0;}
    return DefWindowProcA(hwnd,message,wparam,lparam);
}

static HWND create_agent_window(HINSTANCE instance,int show) {
    WNDCLASSA wc;HWND hwnd;HFONT font;int x,y;char build_text[128];
    memset(&wc,0,sizeof(wc));wc.style=CS_HREDRAW|CS_VREDRAW;wc.lpfnWndProc=agent_window_proc;wc.hInstance=instance;wc.hIcon=LoadIconA(0,IDI_APPLICATION);wc.hCursor=LoadCursorA(0,IDC_ARROW);wc.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);wc.lpszClassName="WIN98CTL_STATUS_WINDOW";
    if(!RegisterClassA(&wc)&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS)return 0;x=(GetSystemMetrics(SM_CXSCREEN)-360)/2;y=(GetSystemMetrics(SM_CYSCREEN)-155)/2;if(x<0)x=0;if(y<0)y=0;
    hwnd=CreateWindowA("WIN98CTL_STATUS_WINDOW","WIN98CTL",WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,x,y,360,155,0,0,instance,0);if(!hwnd)return 0;agent_main_window=hwnd;font=(HFONT)GetStockObject(DEFAULT_GUI_FONT);sprintf(build_text,"Windows 98 remote control agent - %s",BUILD_ID);
    {HWND build=CreateWindowA("STATIC",build_text,WS_CHILD|WS_VISIBLE|SS_LEFT,14,14,325,18,hwnd,0,instance,0);if(build&&font)SendMessageA(build,WM_SETFONT,(WPARAM)font,TRUE);}
    agent_status_window=CreateWindowA("STATIC","Starting...",WS_CHILD|WS_VISIBLE|SS_LEFT,14,43,325,34,hwnd,0,instance,0);agent_close_button=CreateWindowA("BUTTON","Close",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_DEFPUSHBUTTON,255,86,84,26,hwnd,(HMENU)ID_CLOSE_BUTTON,instance,0);
    if(agent_status_window&&font)SendMessageA(agent_status_window,WM_SETFONT,(WPARAM)font,TRUE);if(agent_close_button&&font)SendMessageA(agent_close_button,WM_SETFONT,(WPARAM)font,TRUE);ShowWindow(hwnd,show?show:SW_SHOW);UpdateWindow(hwnd);return hwnd;
}

int WINAPI WinMain(HINSTANCE hi,HINSTANCE prev,LPSTR cmd,int show) {
    HANDLE mutex;HWND hwnd;MSG message;DWORD thread_id;int message_result;
    (void)prev;if(!load_config())return 2;
    if(strstr(cmd,"--install")){MessageBoxA(0,install_startup()?"Startup registration installed.":"Startup registration failed.","WIN98CTL",MB_OK);return 0;}
    if(strstr(cmd,"--self-test"))return self_test();
    mutex=CreateMutexA(0,FALSE,"WIN98CTL_AGENT_SINGLE_INSTANCE");if(!mutex)return 3;if(GetLastError()==ERROR_ALREADY_EXISTS){log_line("second instance ignored; existing agent owns the reconnect loop");MessageBoxA(0,"WIN98CTL is already running.","WIN98CTL",MB_OK|MB_ICONINFORMATION);CloseHandle(mutex);return 3;}
    InitializeCriticalSection(&agent_status_lock);InitializeCriticalSection(&agent_socket_lock);agent_stop_event=CreateEventA(0,TRUE,FALSE,0);if(!agent_stop_event){DeleteCriticalSection(&agent_socket_lock);DeleteCriticalSection(&agent_status_lock);CloseHandle(mutex);return 4;}
    hwnd=create_agent_window(hi,show);if(!hwnd){CloseHandle(agent_stop_event);agent_stop_event=0;DeleteCriticalSection(&agent_socket_lock);DeleteCriticalSection(&agent_status_lock);CloseHandle(mutex);return 5;}
    agent_worker_thread=CreateThread(0,0,agent_network_thread,0,0,&thread_id);if(!agent_worker_thread)set_agent_status("Could not start the network worker.");
    while((message_result=GetMessageA(&message,0,0,0))>0){TranslateMessage(&message);DispatchMessageA(&message);}if(agent_stop_event)SetEvent(agent_stop_event);interrupt_agent_socket();if(agent_worker_thread){WaitForSingleObject(agent_worker_thread,20000);CloseHandle(agent_worker_thread);agent_worker_thread=0;}if(agent_stop_event){CloseHandle(agent_stop_event);agent_stop_event=0;}DeleteCriticalSection(&agent_socket_lock);DeleteCriticalSection(&agent_status_lock);CloseHandle(mutex);if(log_file){fclose(log_file);log_file=0;}return message_result<0?6:0;
}
