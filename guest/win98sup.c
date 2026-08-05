/* WIN98SUP - local heartbeat watchdog for WIN98CTL on Windows 95/98. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

#define BUILD_ID "win98sup-0.3.2"
#define ID_EXIT 2001
#define SUP_TIMER 1
#define RESTART_DELAY_MS 2000UL
#define HEARTBEAT_TIMEOUT_MS 8000UL
#define HEARTBEAT_POLL_MS 250
#define SUPERVISOR_STOP_EVENT "WIN98SUP_STOP_EVENT"

static char g_dir[MAX_PATH];
static char g_agent[MAX_PATH];
static char g_log[MAX_PATH];
static char g_state[MAX_PATH];
static char g_heartbeat[MAX_PATH];
static PROCESS_INFORMATION g_child;
static int g_child_running;
static int g_stopping;
static int g_heartbeat_test;
static int g_fault_test;
static int g_fault_signal_test;
static int g_heartbeat_kill;
static unsigned long g_restart_count;
static unsigned long g_restart_due;
static unsigned long g_heartbeat_start_deadline;
static unsigned long g_last_heartbeat_sequence;
static unsigned long g_last_persisted_heartbeat_sequence;
static unsigned long g_last_heartbeat_tick;
static unsigned long g_last_heartbeat_age=0xffffffffUL;
static DWORD g_last_exit_code;
static char g_last_restart_reason[80]="starting";
static char g_status_text[128]="Starting...";
static HWND g_status;
static HANDLE g_stop_event;

static void log_line(const char *text) {
    FILE *f; SYSTEMTIME t;
    GetLocalTime(&t); f=fopen(g_log,"a");
    if(f){fprintf(f,"%04u-%02u-%02u %02u:%02u:%02u %s\n",t.wYear,t.wMonth,t.wDay,t.wHour,t.wMinute,t.wSecond,text);fclose(f);}
}
static void write_state(void) {
    FILE *f=fopen(g_state,"w");
    if(f){fprintf(f,"state=%s\r\nrestarts=%lu\r\nlastExitCode=%lu\r\nlastRestartReason=%s\r\nlastHeartbeatSequence=%lu\r\nlastHeartbeatTick=%lu\r\nlastHeartbeatAgeMs=%lu\r\nbuild=%s\r\n",g_status_text,g_restart_count,(unsigned long)g_last_exit_code,g_last_restart_reason,g_last_heartbeat_sequence,g_last_heartbeat_tick,g_last_heartbeat_age,BUILD_ID);fclose(f);}
}
static void set_status(const char *text) {
    strncpy(g_status_text,text,sizeof(g_status_text)-1);g_status_text[sizeof(g_status_text)-1]=0;
    if(g_status)SetWindowTextA(g_status,g_status_text);
    write_state();
}
static void set_restart_reason(const char *reason) {
    strncpy(g_last_restart_reason,reason,sizeof(g_last_restart_reason)-1);
    g_last_restart_reason[sizeof(g_last_restart_reason)-1]=0;
}
static int tick_due(unsigned long now,unsigned long deadline) {
    return deadline&&(long)(now-deadline)>=0;
}
static int heartbeat_is_fresh(unsigned long now) {
    FILE *f; unsigned long pid=0,sequence=0,tick=0,age; char build[64];
    f=fopen(g_heartbeat,"r");
    /* WIN98CTL writes a compact local file with stdio.  Windows 9x does not
       provide a dependable replace-existing rename primitive, so a supervisor
       poll can occasionally see the file between truncate and close.  Keep
       the last complete record; its agent tick still ages out after eight
       seconds if the child really stopped. */
    if(!f)return g_last_heartbeat_tick&&now-g_last_heartbeat_tick<=HEARTBEAT_TIMEOUT_MS;
    build[0]=0;
    if(fscanf(f,"pid=%lu\nsequence=%lu\ntick=%lu\nbuild=%63s",&pid,&sequence,&tick,build)!=4){fclose(f);return g_last_heartbeat_tick&&now-g_last_heartbeat_tick<=HEARTBEAT_TIMEOUT_MS;}
    fclose(f);
    if(pid!=(unsigned long)g_child.dwProcessId)return 0;
    age=now-tick;
    g_last_heartbeat_sequence=sequence;
    g_last_heartbeat_tick=tick;
    g_last_heartbeat_age=age;
    return age<=HEARTBEAT_TIMEOUT_MS;
}
static int start_agent(void) {
    STARTUPINFOA si; char command[MAX_PATH+96];
    if(GetFileAttributesA(g_agent)==0xffffffffUL){set_status("WIN98CTL.EXE is missing");log_line("WIN98CTL.EXE is missing; retrying");return 0;}
    DeleteFileA(g_heartbeat);
    memset(&si,0,sizeof(si)); memset(&g_child,0,sizeof(g_child)); si.cb=sizeof(si);
    _snprintf(command,sizeof(command),"\"%s\" --supervised%s%s%s",g_agent,g_heartbeat_test?" --heartbeat-test":"",g_fault_test?" --fault-after-heartbeat-test":"",g_fault_signal_test?" --fault-signal-after-heartbeat-test":""); command[sizeof(command)-1]=0;
    if(!CreateProcessA(0,command,0,0,FALSE,0,0,g_dir,&si,&g_child)){char line[160];_snprintf(line,sizeof(line),"CreateProcessA failed (error %lu)",(unsigned long)GetLastError());line[sizeof(line)-1]=0;log_line(line);set_status("Could not start WIN98CTL; retrying");return 0;}
    g_child_running=1;g_heartbeat_kill=0;g_heartbeat_start_deadline=GetTickCount()+HEARTBEAT_TIMEOUT_MS;g_last_heartbeat_sequence=0;g_last_persisted_heartbeat_sequence=0;g_last_heartbeat_tick=0;g_last_heartbeat_age=0xffffffffUL;g_restart_count++;g_heartbeat_test=0;g_fault_test=0;g_fault_signal_test=0;set_status("WIN98CTL running");log_line("started WIN98CTL supervised child; waiting for local heartbeat");return 1;
}
static void stop_child(void) {
    if(!g_child_running)return;
    set_restart_reason("supervisor_exit");
    TerminateProcess(g_child.hProcess,0);
    WaitForSingleObject(g_child.hProcess,5000);
    CloseHandle(g_child.hProcess);CloseHandle(g_child.hThread);memset(&g_child,0,sizeof(g_child));g_child_running=0;
}
static void schedule_restart(unsigned long now,const char *reason) {
    set_restart_reason(reason);
    g_restart_due=now+RESTART_DELAY_MS;
    set_status("WIN98CTL stopped; recovering");
}
static void inspect_child(void) {
    DWORD exit_code=0; unsigned long now=GetTickCount(); char line[192];
    if(g_child_running&&heartbeat_is_fresh(now)){
        if(g_last_heartbeat_sequence!=g_last_persisted_heartbeat_sequence){g_last_persisted_heartbeat_sequence=g_last_heartbeat_sequence;write_state();}
    }
    else if(g_child_running&&!g_heartbeat_kill&&tick_due(now,g_heartbeat_start_deadline)){
        g_heartbeat_kill=1;
        set_restart_reason("heartbeat_stale");
        set_status("WIN98CTL heartbeat stale; restarting...");
        _snprintf(line,sizeof(line),"heartbeat stale for child pid %lu; terminating owned child",(unsigned long)g_child.dwProcessId);line[sizeof(line)-1]=0;log_line(line);
        TerminateProcess(g_child.hProcess,1);
    }
    if(g_child_running&&WaitForSingleObject(g_child.hProcess,0)==WAIT_OBJECT_0){
        GetExitCodeProcess(g_child.hProcess,&exit_code);g_last_exit_code=exit_code;CloseHandle(g_child.hProcess);CloseHandle(g_child.hThread);memset(&g_child,0,sizeof(g_child));g_child_running=0;
        _snprintf(line,sizeof(line),"WIN98CTL exited (exit code %lu)",(unsigned long)exit_code);line[sizeof(line)-1]=0;log_line(line);
        if(!g_stopping)schedule_restart(now,g_heartbeat_kill?"heartbeat_stale":"child_exit");
        g_heartbeat_kill=0;
    }
    if(g_stopping)return;
    if(!g_child_running&&tick_due(now,g_restart_due)){g_restart_due=now+RESTART_DELAY_MS;log_line("restart delay elapsed; starting WIN98CTL");if(start_agent())g_restart_due=0;}
}
static int install_startup(void) {
    HKEY key; char exe[MAX_PATH],value[MAX_PATH+3]; LONG r;DWORD disposition;
    if(!GetModuleFileNameA(0,exe,sizeof(exe))||_snprintf(value,sizeof(value),"\"%s\"",exe)<0)return 0;
    r=RegCreateKeyExA(HKEY_CURRENT_USER,"Software\\Microsoft\\Windows\\CurrentVersion\\Run",0,0,REG_OPTION_NON_VOLATILE,KEY_SET_VALUE,0,&key,&disposition);
    if(r!=ERROR_SUCCESS)return 0; RegDeleteValueA(key,"WIN98CTL");r=RegSetValueExA(key,"WIN98SUP",0,REG_SZ,(BYTE*)value,strlen(value)+1);RegCloseKey(key);return r==ERROR_SUCCESS;
}
static int uninstall_startup(void) {
    HKEY key;HANDLE stop_event;LONG r;
    r=RegOpenKeyExA(HKEY_CURRENT_USER,"Software\\Microsoft\\Windows\\CurrentVersion\\Run",0,KEY_SET_VALUE,&key);
    if(r!=ERROR_SUCCESS)return 0;
    RegDeleteValueA(key,"WIN98SUP");RegDeleteValueA(key,"WIN98CTL");RegCloseKey(key);
    stop_event=OpenEventA(EVENT_MODIFY_STATE,FALSE,SUPERVISOR_STOP_EVENT);
    if(stop_event){SetEvent(stop_event);CloseHandle(stop_event);}return 1;
}
static LRESULT CALLBACK window_proc(HWND hwnd,UINT msg,WPARAM wp,LPARAM lp) {
    if(msg==WM_COMMAND&&LOWORD(wp)==ID_EXIT){g_stopping=1;set_status("Stopping WIN98CTL...");stop_child();DestroyWindow(hwnd);return 0;}
    if(msg==WM_CLOSE){SendMessageA(hwnd,WM_COMMAND,ID_EXIT,0);return 0;}
    if(msg==WM_TIMER){if(g_stop_event&&WaitForSingleObject(g_stop_event,0)==WAIT_OBJECT_0){SendMessageA(hwnd,WM_COMMAND,ID_EXIT,0);return 0;}inspect_child();return 0;}
    if(msg==WM_DESTROY){KillTimer(hwnd,SUP_TIMER);PostQuitMessage(0);return 0;}
    return DefWindowProcA(hwnd,msg,wp,lp);
}
int WINAPI WinMain(HINSTANCE instance,HINSTANCE previous,LPSTR command,int show) {
    WNDCLASSA wc; HWND hwnd; MSG msg; char module[MAX_PATH],*slash;int uninstall_ok;
    (void)previous;
    if(strstr(command,"--install")){uninstall_ok=install_startup();MessageBoxA(0,uninstall_ok?"Supervisor startup registration installed.":"Supervisor startup registration failed.","WIN98SUP",MB_OK);return uninstall_ok?0:1;}
    if(strstr(command,"--uninstall")){uninstall_ok=uninstall_startup();MessageBoxA(0,uninstall_ok?"Supervisor startup registration removed and running supervisor asked to exit.":"Supervisor startup registration removal failed.","WIN98SUP",MB_OK);return uninstall_ok?0:1;}
    if(!GetModuleFileNameA(0,module,sizeof(module)))return 2;strcpy(g_dir,module);slash=strrchr(g_dir,'\\');if(!slash)return 2;*slash=0;
    _snprintf(g_agent,sizeof(g_agent),"%s\\WIN98CTL.EXE",g_dir);_snprintf(g_log,sizeof(g_log),"%s\\MCPSUPERVISOR.LOG",g_dir);_snprintf(g_state,sizeof(g_state),"%s\\MCPSUPERVISOR.TXT",g_dir);_snprintf(g_heartbeat,sizeof(g_heartbeat),"%s\\MCPHEARTBEAT.TXT",g_dir);
    if(strstr(command,"--self-test")){FILE*f=fopen(g_state,"w");if(!f)return 1;fprintf(f,"state=Supervisor self-test PASS\r\nbuild=%s\r\n",BUILD_ID);fclose(f);return GetFileAttributesA(g_agent)==0xffffffffUL?1:0;}
    g_heartbeat_test=strstr(command,"--heartbeat-test")!=0;
    g_fault_test=strstr(command,"--fault-test")!=0;
    g_fault_signal_test=strstr(command,"--fault-signal-test")!=0;
    g_stop_event=CreateEventA(0,TRUE,FALSE,SUPERVISOR_STOP_EVENT);if(!g_stop_event)return 3;
    memset(&wc,0,sizeof(wc));wc.lpfnWndProc=window_proc;wc.hInstance=instance;wc.hIcon=LoadIconA(0,IDI_APPLICATION);wc.hCursor=LoadCursorA(0,IDC_ARROW);wc.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);wc.lpszClassName="WIN98SUP_STATUS_WINDOW";
    if(!RegisterClassA(&wc)&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS){CloseHandle(g_stop_event);return 4;}
    hwnd=CreateWindowA("WIN98SUP_STATUS_WINDOW","Windows 98 MCP Supervisor",WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,100,100,370,145,0,0,instance,0);if(!hwnd){CloseHandle(g_stop_event);return 5;}
    CreateWindowA("STATIC","WIN98CTL heartbeat supervisor",WS_CHILD|WS_VISIBLE,14,14,320,20,hwnd,0,instance,0);g_status=CreateWindowA("STATIC","Starting...",WS_CHILD|WS_VISIBLE,14,44,320,20,hwnd,0,instance,0);CreateWindowA("BUTTON","Exit supervisor",WS_CHILD|WS_VISIBLE|WS_TABSTOP,230,76,115,25,hwnd,(HMENU)ID_EXIT,instance,0);ShowWindow(hwnd,show?show:SW_SHOW);UpdateWindow(hwnd);SetTimer(hwnd,SUP_TIMER,HEARTBEAT_POLL_MS,0);log_line("heartbeat supervisor started");start_agent();while(GetMessageA(&msg,0,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}log_line("supervisor stopped");CloseHandle(g_stop_event);return 0;
}
