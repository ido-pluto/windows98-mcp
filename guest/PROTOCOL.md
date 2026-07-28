# Guest protocol notes

`WIN98CTL.EXE` implements protocol v1 from `src/shared/types.ts`:

- 28-byte little-endian `W98M` header, payload, then 32-byte MAC.
- Unsigned handshake frames carry a zero MAC.
- Guest hello: `{kind, guestNonce, guestId, guestBuildId}`.
- Nonces and proofs are canonical base64 in JSON.
- Session key: HMAC-SHA256(PSK, `"session-key\0"` + guest nonce + host nonce).
- Challenge proof: HMAC-SHA256(session key, `"host-proof\0"`).
- Guest proof: HMAC-SHA256(session key, `"guest-proof\0"`).
- Signed frame MAC input is ASCII direction (`host-to-guest` or
  `guest-to-host`) + encoded header + payload.
- Guest operational sequences begin at one. The host's signed Authenticated
  frame is sequence one, so its first Request is sequence two.
- Control frames are limited to 1 MiB and data frames to 64 KiB.

Operational messages use the `GuestRequest`/`GuestResponse` JSON envelopes.
File transfer uses `file_read_chunk`, `file_write_begin`, `file_write_chunk`,
`file_write_commit`, and `file_write_abort`. Directory traversal is orchestrated
by the host through `fs_list`.

Long-running shell and input operations cooperatively service authenticated
`PING`, `CANCEL`, `session_abort`, and `sanitize` frames. Other requests receive
`VM_BUSY` until the active operation finishes. Every dispatched error releases
all guest-tracked keys and mouse buttons.

Shell output is one ordered `stdout+stderr` byte stream because both child
handles intentionally target the same redirected pipe. `shell_read` addresses
that stream with an absolute byte cursor and retains the latest 128 KiB. Reading
before the retained range returns `CURSOR_EXPIRED` with the earliest and latest
valid cursors. Synchronous `shell_exec` responses include the ending cursor and
an `outputTruncated` flag when their inline 64 KiB view did not contain the
entire combined stream.

Uploads use deterministic destination-adjacent `.W98PART` and `.W98META` files.
A matching begin request rehashes the complete retained prefix and reports its
verified nonzero `resumeOffset`. Unknown or incomplete sibling artifacts cause
`TRANSFER_RESUME_CONFLICT`; they are not deleted. Explicit abort and connection
cleanup preserve a valid partial upload for a later resume.

The transport is Winsock 2 (`WS2_32.DLL`, requested version 2.0).

Known v1 limitations:

- The guest verifies each transfer chunk CRC32 plus final size and SHA-256.
- `fs_list(recursive=true)` returns relative descendant names. The broker uses
  one-level calls while orchestrating directory transfers.
- Screenshot payloads are base64 Windows BMP (`image/bmp`) containing a 24-bit
  bottom-up BGR DIB. The host converts this to PNG MCP image content.
- Cursor composition uses `GetCursorInfo` when exported and falls back to
  `GetCursor`/`GetCursorPos` on base Windows 98. Because `GetCursor` is
  thread-scoped, the fallback may still omit a cursor owned by another process;
  screenshot metadata always reports the global cursor position.
- Redirected shell sessions do not emulate a full-screen DOS console. Modal
  process windows are reported as `NEEDS_ATTENTION` with a current screenshot
  and a live session ID for continued control.
