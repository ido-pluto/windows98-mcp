/* WIN98SUP - small Win95/98-compatible supervisor for WIN98CTL. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

#define BUILD_ID "win98sup-0.2.0"
#define ID_EXIT 2001
#define SUP_TIMER 1
#define RESTART_DELAY_MS 2000UL
#define FAULT_EXIT_TIMEOUT_MS 5000UL

static char g_dir[MAX_PATH];
static char g_agent[MAX_PATH];
static char g_log[MAX_PATH];
static char g_state[MAX_PATH];
static PROCESS_INFORMATION g_child;
static int g_child_running;
static int g_stopping;
static unsigned long g_restart_count;
static unsigned long g_restart_due;
static unsigned long g_fault_terminate_due;
static int g_fault_test;
static int g_fault_dialog_seen;
static HWND g_status;
static HWND g_exit;

static void log_line(const char *text) {
    FILE *f; SYSTEMTIME t;
    GetLocalTime(&t); f=fopen(g_log,"a");
    if(f){fprintf(f,"%04u-%02u-%02u %02u:%02u:%02u %s\n",t.wYear,t.wMonth,t.wDay,t.wHour,t.wMinute,t.wSecond,text);fclose(f);}
}
static void write_state(const char *state, DWORD code) {
    FILE *f=fopen(g_state,"w");
    if(f){fprintf(f,"state=%s\r\nrestarts=%lu\r\nlastExitCode=%lu\r\nbuild=%s\r\n",state,g_restart_count,(unsigned long)code,BUILD_ID);fclose(f);}
}
static void set_status(const char *text) {
    if(g_status)SetWindowTextA(g_status,text);
    write_state(text,0);
}
static int child_window_cb(HWND window, LPARAM param) {
    DWORD pid=0; GetWindowThreadProcessId(window,&pid);
    if(pid==(DWORD)param && IsWindowVisible(window)){PostMessageA(window,WM_CLOSE,0,0);return FALSE;}
    return TRUE;
}
typedef struct {
    int matched;
    HWND close_button;
} FAULT_DIALOG;

static int fault_text_cb(HWND child, LPARAM param) {
    char text[512],cls[64]; FAULT_DIALOG *dialog=(FAULT_DIALOG*)param;
    GetWindowTextA(child,text,sizeof(text));
    if(strstr(text,"illegal operation")||strstr(text,"Illegal Operation")||strstr(text,"invalid page fault")||strstr(text,"Invalid Page Fault"))dialog->matched=1;
    GetClassNameA(child,cls,sizeof(cls));
    if(!strcmp(cls,"Button")&&(!strcmp(text,"Close")||!strcmp(text,"&Close")))dialog->close_button=child;
    return TRUE;
}
static int close_fault_dialog_cb(HWND window, LPARAM param) {
    char title[128],cls[64]; FAULT_DIALOG dialog;
    (void)param;
    if(!IsWindowVisible(window))return TRUE;
    GetClassNameA(window,cls,sizeof(cls)); if(strcmp(cls,"#32770"))return TRUE;
    GetWindowTextA(window,title,sizeof(title));
    if(!strstr(title,"WIN98CTL")&&!strstr(title,"Win98ctl"))return TRUE;
    memset(&dialog,0,sizeof(dialog));EnumChildWindows(window,(WNDENUMPROC)fault_text_cb,(LPARAM)&dialog);
    if(dialog.matched){
        if(!g_fault_dialog_seen){
            g_fault_dialog_seen=1;
            g_fault_terminate_due=GetTickCount()+FAULT_EXIT_TIMEOUT_MS;
            set_status("WIN98CTL crash dialog detected; closing...");
            log_line("detected confirmed WIN98CTL fault dialog; closing it");
        }
        if(dialog.close_button)PostMessageA(dialog.close_button,BM_CLICK,0,0);
        else PostMessageA(window,WM_CLOSE,0,0);
        return FALSE;
    }
    return TRUE;
}
static int close_confirmed_fault_dialog(void) {
    int was_seen=g_fault_dialog_seen;
    EnumWindows((WNDENUMPROC)close_fault_dialog_cb,0);
    return g_fault_dialog_seen&&!was_seen;
}
static int start_agent(void) {
    STARTUPINFOA si; char command[MAX_PATH+32];
    if(GetFileAttributesA(g_agent)==0xffffffffUL){set_status("WIN98CTL.EXE is missing");log_line("WIN98CTL.EXE is missing; retrying");return 0;}
    memset(&si,0,sizeof(si)); memset(&g_child,0,sizeof(g_child)); si.cb=sizeof(si);
    _snprintf(command,sizeof(command),"\"%s\" --supervised%s",g_agent,g_fault_test?" --fault-test":""); command[sizeof(command)-1]=0;
    if(!CreateProcessA(0,command,0,0,FALSE,0,0,g_dir,&si,&g_child)){char line[160];_snprintf(line,sizeof(line),"CreateProcessA failed (error %lu)",(unsigned long)GetLastError());line[sizeof(line)-1]=0;log_line(line);set_status("Could not start WIN98CTL; retrying");return 0;}
    g_child_running=1;g_fault_terminate_due=0;g_fault_dialog_seen=0;g_restart_count++;g_fault_test=0;set_status("WIN98CTL running");log_line("started WIN98CTL supervised child");return 1;
}
static void stop_child(void) {
    if(!g_child_running)return;
    EnumWindows((WNDENUMPROC)child_window_cb,(LPARAM)g_child.dwProcessId);
    if(WaitForSingleObject(g_child.hProcess,10000)!=WAIT_OBJECT_0)TerminateProcess(g_child.hProcess,0);
    CloseHandle(g_child.hProcess);CloseHandle(g_child.hThread);memset(&g_child,0,sizeof(g_child));g_child_running=0;
}
static void inspect_child(void) {
    DWORD exit_code=0; unsigned long now=GetTickCount(); char line[160];
    /* Windows 98 keeps a faulting program alive until the illegal-operation
       dialog is dismissed. Poll while the child is still alive. */
    if(g_child_running){
        close_confirmed_fault_dialog();
        if(g_fault_terminate_due&&(long)(now-g_fault_terminate_due)>=0){
            log_line("confirmed WIN98CTL fault dialog did not end child; forcing termination");
            TerminateProcess(g_child.hProcess,1);
            g_fault_terminate_due=0;
        }
    }
    if(g_child_running&&WaitForSingleObject(g_child.hProcess,0)==WAIT_OBJECT_0){
        GetExitCodeProcess(g_child.hProcess,&exit_code);CloseHandle(g_child.hProcess);CloseHandle(g_child.hThread);memset(&g_child,0,sizeof(g_child));g_child_running=0;g_fault_terminate_due=0;
        _snprintf(line,sizeof(line),"WIN98CTL exited unexpectedly (exit code %lu); restart scheduled",(unsigned long)exit_code);line[sizeof(line)-1]=0;log_line(line);write_state("WIN98CTL exited",exit_code);set_status("WIN98CTL stopped; recovering");g_restart_due=now+RESTART_DELAY_MS;
    }
    if(g_stopping)return;
    if(!g_child_running&&g_restart_due&&(long)(now-g_restart_due)>=0){g_restart_due=now+RESTART_DELAY_MS;log_line("restart delay elapsed; starting WIN98CTL");if(start_agent())g_restart_due=0;}
}
static int install_startup(void) {
    HKEY key; char exe[MAX_PATH],value[MAX_PATH+3]; LONG r;
    if(!GetModuleFileNameA(0,exe,sizeof(exe))||_snprintf(value,sizeof(value),"\"%s\"",exe)<0)return 0;
    r=RegOpenKeyExA(HKEY_CURRENT_USER,"Software\\Microsoft\\Windows\\CurrentVersion\\Run",0,KEY_SET_VALUE,&key);
    if(r!=ERROR_SUCCESS)return 0; RegDeleteValueA(key,"WIN98CTL");r=RegSetValueExA(key,"WIN98SUP",0,REG_SZ,(BYTE*)value,strlen(value)+1);RegCloseKey(key);return r==ERROR_SUCCESS;
}
static int supervisor_window_cb(HWND window, LPARAM unused) {
    char cls[64];(void)unused;GetClassNameA(window,cls,sizeof(cls));
    if(!strcmp(cls,"WIN98SUP_STATUS_WINDOW")){PostMessageA(window,WM_CLOSE,0,0);}
    return TRUE;
}
static int uninstall_startup(void) {
    HKEY key;LONG r;
    r=RegOpenKeyExA(HKEY_CURRENT_USER,"Software\\Microsoft\\Windows\\CurrentVersion\\Run",0,KEY_SET_VALUE,&key);
    if(r!=ERROR_SUCCESS)return 0;
    RegDeleteValueA(key,"WIN98SUP");RegDeleteValueA(key,"WIN98CTL");RegCloseKey(key);
    /* This closes an already-running supervisor, which then gracefully closes
       its owned agent before exiting. */
    EnumWindows((WNDENUMPROC)supervisor_window_cb,0);return 1;
}
static LRESULT CALLBACK window_proc(HWND hwnd,UINT msg,WPARAM wp,LPARAM lp) {
    if(msg==WM_COMMAND&&LOWORD(wp)==ID_EXIT){g_stopping=1;set_status("Stopping WIN98CTL...");stop_child();DestroyWindow(hwnd);return 0;}
    if(msg==WM_CLOSE){SendMessageA(hwnd,WM_COMMAND,ID_EXIT,0);return 0;}
    if(msg==WM_TIMER){inspect_child();return 0;}
    if(msg==WM_DESTROY){KillTimer(hwnd,SUP_TIMER);PostQuitMessage(0);return 0;}
    return DefWindowProcA(hwnd,msg,wp,lp);
}
int WINAPI WinMain(HINSTANCE instance,HINSTANCE previous,LPSTR command,int show) {
    WNDCLASSA wc; HWND hwnd; MSG msg; char module[MAX_PATH],*slash;int uninstall_ok;
    (void)previous;
    if(strstr(command,"--install")){MessageBoxA(0,install_startup()?"Supervisor startup registration installed.":"Supervisor startup registration failed.","WIN98SUP",MB_OK);return 0;}
    if(strstr(command,"--uninstall")){uninstall_ok=uninstall_startup();MessageBoxA(0,uninstall_ok?"Supervisor startup registration removed and running supervisor asked to exit.":"Supervisor startup registration removal failed.","WIN98SUP",MB_OK);return uninstall_ok?0:1;}
    if(!GetModuleFileNameA(0,module,sizeof(module)))return 2;strcpy(g_dir,module);slash=strrchr(g_dir,'\\');if(!slash)return 2;*slash=0;
    _snprintf(g_agent,sizeof(g_agent),"%s\\WIN98CTL.EXE",g_dir);_snprintf(g_log,sizeof(g_log),"%s\\MCPSUPERVISOR.LOG",g_dir);_snprintf(g_state,sizeof(g_state),"%s\\MCPSUPERVISOR.TXT",g_dir);
    if(strstr(command,"--self-test")){FILE*f=fopen(g_state,"w");if(!f)return 1;fprintf(f,"state=Supervisor self-test PASS\r\nbuild=%s\r\n",BUILD_ID);fclose(f);return GetFileAttributesA(g_agent)==0xffffffffUL?1:0;}
    g_fault_test=strstr(command,"--fault-test")!=0;
    memset(&wc,0,sizeof(wc));wc.lpfnWndProc=window_proc;wc.hInstance=instance;wc.hIcon=LoadIconA(0,IDI_APPLICATION);wc.hCursor=LoadCursorA(0,IDC_ARROW);wc.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);wc.lpszClassName="WIN98SUP_STATUS_WINDOW";
    if(!RegisterClassA(&wc)&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS)return 3;
    hwnd=CreateWindowA("WIN98SUP_STATUS_WINDOW","Windows 98 MCP Supervisor",WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,100,100,370,145,0,0,instance,0);if(!hwnd)return 4;
    CreateWindowA("STATIC","WIN98CTL recovery supervisor",WS_CHILD|WS_VISIBLE,14,14,320,20,hwnd,0,instance,0);g_status=CreateWindowA("STATIC","Starting...",WS_CHILD|WS_VISIBLE,14,44,320,20,hwnd,0,instance,0);g_exit=CreateWindowA("BUTTON","Exit supervisor",WS_CHILD|WS_VISIBLE|WS_TABSTOP,230,76,115,25,hwnd,(HMENU)ID_EXIT,instance,0);ShowWindow(hwnd,show?show:SW_SHOW);UpdateWindow(hwnd);SetTimer(hwnd,SUP_TIMER,250,0);log_line("supervisor started");start_agent();while(GetMessageA(&msg,0,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}log_line("supervisor stopped");return 0;
}
