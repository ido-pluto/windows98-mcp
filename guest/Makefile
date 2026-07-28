# Open Watcom V2 build for Windows 95/98 (PE32 x86, GUI subsystem).
# Run through scripts/build-guest.ps1 so the compiler environment is correct.

CC = wcc386
LINK = wlink
CFLAGS = -q -3r -os -s -w4 -bt=windows -dWINVER=0x0400 -d_WIN32_WINDOWS=0x0400

OBJS = build\win98ctl.obj build\protocol.obj build\sha256.obj

.before
    if not exist build mkdir build
    if not exist dist mkdir dist

all: dist\WIN98CTL.EXE

build\win98ctl.obj: win98ctl.c protocol.h sha256.h
    $(CC) $(CFLAGS) -fo=$@ win98ctl.c

build\protocol.obj: protocol.c protocol.h sha256.h
    $(CC) $(CFLAGS) -fo=$@ protocol.c

build\sha256.obj: sha256.c sha256.h
    $(CC) $(CFLAGS) -fo=$@ sha256.c

dist\WIN98CTL.EXE: $(OBJS) win98ctl.lnk
    $(LINK) @win98ctl.lnk

clean: .symbolic
    if exist build\*.obj del build\*.obj
    if exist dist\WIN98CTL.EXE del dist\WIN98CTL.EXE
    if exist dist\WIN98CTL.map del dist\WIN98CTL.map
