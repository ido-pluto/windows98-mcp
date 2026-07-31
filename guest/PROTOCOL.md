# Guest protocol v2

`WIN98CTL.EXE` makes a permanent outbound TCP connection to the host listener.
It uses protocol v2: a 28-byte little-endian `W98M` header followed directly by
the payload. There is no authentication, encryption, MAC, nonce, or secret.

The guest sends one `HELLO` frame (sequence zero) containing its full
capabilities. The host responds with `READY` (sequence zero), after which both
directions start at sequence one. Every frame is checked for its version, size,
and expected sequence number. Data frames are limited to 64 KiB; control frames
to 1 MiB. File and artifact hashes remain end-to-end integrity checks.

If the connection closes or setup fails, the guest releases held input and
reconnects after two seconds. TCP is deliberately guest-to-host only.
