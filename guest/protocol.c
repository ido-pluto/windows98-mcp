#include <stdlib.h>
#include <string.h>
#include "protocol.h"

static void p16(w98_u8 *p,unsigned short v){p[0]=(w98_u8)v;p[1]=(w98_u8)(v>>8);}
static void p32(w98_u8 *p,unsigned long v){p[0]=(w98_u8)v;p[1]=(w98_u8)(v>>8);p[2]=(w98_u8)(v>>16);p[3]=(w98_u8)(v>>24);}
static unsigned short g16(const w98_u8*p){return(unsigned short)(p[0]|((unsigned short)p[1]<<8));}
static unsigned long g32(const w98_u8*p){return(unsigned long)p[0]|((unsigned long)p[1]<<8)|((unsigned long)p[2]<<16)|((unsigned long)p[3]<<24);}
static void header(const W98_FRAME*f,w98_u8 h[28]) {
    memcpy(h,"W98M",4);p16(h+4,W98_PROTO_VERSION);p16(h+6,f->type);p32(h+8,f->flags);p32(h+12,f->stream_id);
    p32(h+16,f->seq_lo);p32(h+20,f->seq_hi);p32(h+24,f->payload_len);
}
static int all_send(SOCKET s,const void*v,unsigned long n) {
    const char*p=(const char*)v;int k;while(n){k=send(s,p,n>32767?32767:(int)n,0);if(k<=0)return 0;p+=k;n-=k;}return 1;
}
static int all_recv(SOCKET s,void*v,unsigned long n) {
    char*p=(char*)v;int k;while(n){k=recv(s,p,n>32767?32767:(int)n,0);if(k<=0)return 0;p+=k;n-=k;}return 1;
}
int w98_send_frame(SOCKET s,unsigned short type,unsigned long flags,unsigned long stream,
 unsigned long lo,unsigned long hi,const void*payload,unsigned long len) {
    W98_FRAME f;w98_u8 h[28];f.type=type;f.flags=flags;f.stream_id=stream;f.seq_lo=lo;f.seq_hi=hi;f.payload_len=len;header(&f,h);
    return all_send(s,h,28)&&(!len||all_send(s,payload,len));
}
int w98_recv_frame(SOCKET s,W98_FRAME*f,w98_u8**payload) {
    w98_u8 h[28];unsigned long max;if(!all_recv(s,h,28)||memcmp(h,"W98M",4)||g16(h+4)!=W98_PROTO_VERSION)return 0;
    f->type=g16(h+6);f->flags=g32(h+8);f->stream_id=g32(h+12);f->seq_lo=g32(h+16);f->seq_hi=g32(h+20);f->payload_len=g32(h+24);
    max=f->type==W98_F_DATA?W98_MAX_DATA:W98_MAX_CONTROL;if(f->payload_len>max)return 0;
    *payload=(w98_u8*)malloc(f->payload_len+1);if(!*payload)return 0;
    if(f->payload_len&&!all_recv(s,*payload,f->payload_len)){free(*payload);return 0;}(*payload)[f->payload_len]=0;
    return 1;
}
int w98_frame_ready(SOCKET s) {
    u_long avail=0,needed,len,max;w98_u8 h[28];int k;fd_set reads;struct timeval tv;
    if(ioctlsocket(s,FIONREAD,&avail)!=0)return -1;
    if(avail<28){FD_ZERO(&reads);FD_SET(s,&reads);tv.tv_sec=0;tv.tv_usec=0;k=select(0,&reads,0,0,&tv);if(k<0)return -1;if(k>0&&avail==0){k=recv(s,(char*)h,1,MSG_PEEK);if(k==0)return -1;if(k<0)return 0;}return 0;}
    k=recv(s,(char*)h,28,MSG_PEEK);if(k<=0)return k<0?0:-1;if(k<28)return 0;
    if(memcmp(h,"W98M",4)||g16(h+4)!=W98_PROTO_VERSION)return 1;len=g32(h+24);max=g16(h+6)==W98_F_DATA?W98_MAX_DATA:W98_MAX_CONTROL;if(len>max)return 1;
    needed=28UL+len;return avail>=needed?1:0;
}
void w98_hex(const w98_u8*in,unsigned long n,char*out){static const char*x="0123456789abcdef";while(n--){*out++=x[*in>>4];*out++=x[*in++&15];}*out=0;}
int w98_unhex(const char*in,w98_u8*out,unsigned long n){int a,b;while(n--){a=*in++;b=*in++;a=a>='a'?a-'a'+10:a>='A'?a-'A'+10:a-'0';b=b>='a'?b-'a'+10:b>='A'?b-'A'+10:b-'0';if(a<0||a>15||b<0||b>15)return 0;*out++=(w98_u8)((a<<4)|b);}return 1;}
