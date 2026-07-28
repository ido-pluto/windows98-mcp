#ifndef W98_PROTOCOL_H
#define W98_PROTOCOL_H
#include <winsock2.h>
#include "sha256.h"

#define W98_PROTO_VERSION 1
#define W98_HEADER_BYTES 28
#define W98_MAC_BYTES 32
#define W98_MAX_CONTROL (1024UL*1024UL)
#define W98_MAX_DATA 65536UL

#define W98_F_HELLO 1
#define W98_F_CHALLENGE 2
#define W98_F_AUTHENTICATE 3
#define W98_F_AUTHENTICATED 4
#define W98_F_REQUEST 10
#define W98_F_RESPONSE 11
#define W98_F_EVENT 12
#define W98_F_DATA 13
#define W98_F_CANCEL 14
#define W98_F_PING 20
#define W98_F_PONG 21
#define W98_F_ERROR 255

typedef struct {
    unsigned short type;
    unsigned long flags,stream_id,seq_lo,seq_hi,payload_len;
} W98_FRAME;

int w98_send_frame(SOCKET s,unsigned short type,unsigned long flags,unsigned long stream,
                   unsigned long seq_lo,unsigned long seq_hi,const void *payload,unsigned long len,
                   const w98_u8 *key,const char *direction);
int w98_recv_frame(SOCKET s,W98_FRAME *f,w98_u8 **payload,w98_u8 mac[32]);
int w98_frame_ready(SOCKET s);
int w98_verify_frame(const W98_FRAME *f,const void *payload,const w98_u8 mac[32],
                     const w98_u8 key[32],const char *direction);
void w98_hex(const w98_u8 *in,unsigned long n,char *out);
int w98_unhex(const char *in,w98_u8 *out,unsigned long n);

#endif
