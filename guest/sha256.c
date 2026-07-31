#include <string.h>
#include "sha256.h"

#define ROR(x,n) (((x) >> (n)) | ((x) << (32-(n))))
#define CH(x,y,z) (((x)&(y)) ^ (~(x)&(z)))
#define MAJ(x,y,z) (((x)&(y)) ^ ((x)&(z)) ^ ((y)&(z)))
#define S0(x) (ROR((x),2)^ROR((x),13)^ROR((x),22))
#define S1(x) (ROR((x),6)^ROR((x),11)^ROR((x),25))
#define G0(x) (ROR((x),7)^ROR((x),18)^((x)>>3))
#define G1(x) (ROR((x),17)^ROR((x),19)^((x)>>10))

static const w98_u32 k[64] = {
  0x428a2f98UL,0x71374491UL,0xb5c0fbcfUL,0xe9b5dba5UL,0x3956c25bUL,0x59f111f1UL,0x923f82a4UL,0xab1c5ed5UL,
  0xd807aa98UL,0x12835b01UL,0x243185beUL,0x550c7dc3UL,0x72be5d74UL,0x80deb1feUL,0x9bdc06a7UL,0xc19bf174UL,
  0xe49b69c1UL,0xefbe4786UL,0x0fc19dc6UL,0x240ca1ccUL,0x2de92c6fUL,0x4a7484aaUL,0x5cb0a9dcUL,0x76f988daUL,
  0x983e5152UL,0xa831c66dUL,0xb00327c8UL,0xbf597fc7UL,0xc6e00bf3UL,0xd5a79147UL,0x06ca6351UL,0x14292967UL,
  0x27b70a85UL,0x2e1b2138UL,0x4d2c6dfcUL,0x53380d13UL,0x650a7354UL,0x766a0abbUL,0x81c2c92eUL,0x92722c85UL,
  0xa2bfe8a1UL,0xa81a664bUL,0xc24b8b70UL,0xc76c51a3UL,0xd192e819UL,0xd6990624UL,0xf40e3585UL,0x106aa070UL,
  0x19a4c116UL,0x1e376c08UL,0x2748774cUL,0x34b0bcb5UL,0x391c0cb3UL,0x4ed8aa4aUL,0x5b9cca4fUL,0x682e6ff3UL,
  0x748f82eeUL,0x78a5636fUL,0x84c87814UL,0x8cc70208UL,0x90befffaUL,0xa4506cebUL,0xbef9a3f7UL,0xc67178f2UL
};

static w98_u32 get32(const w98_u8 *p) {
    return ((w98_u32)p[0]<<24)|((w98_u32)p[1]<<16)|((w98_u32)p[2]<<8)|p[3];
}
static void put32(w98_u8 *p,w98_u32 x) {
    p[0]=(w98_u8)(x>>24); p[1]=(w98_u8)(x>>16); p[2]=(w98_u8)(x>>8); p[3]=(w98_u8)x;
}
static void transform(W98_SHA256_CTX *c,const w98_u8 *p) {
    w98_u32 w[64],a,b,d,e,f,g,h,t1,t2,cc; int i;
    for(i=0;i<16;i++) w[i]=get32(p+i*4);
    for(i=16;i<64;i++) w[i]=G1(w[i-2])+w[i-7]+G0(w[i-15])+w[i-16];
    a=c->state[0]; b=c->state[1]; cc=c->state[2]; d=c->state[3];
    e=c->state[4]; f=c->state[5]; g=c->state[6]; h=c->state[7];
    for(i=0;i<64;i++){t1=h+S1(e)+CH(e,f,g)+k[i]+w[i];t2=S0(a)+MAJ(a,b,cc);
      h=g;g=f;f=e;e=d+t1;d=cc;cc=b;b=a;a=t1+t2;}
    c->state[0]+=a;c->state[1]+=b;c->state[2]+=cc;c->state[3]+=d;
    c->state[4]+=e;c->state[5]+=f;c->state[6]+=g;c->state[7]+=h;
}
void w98_sha256_init(W98_SHA256_CTX *c) {
    c->state[0]=0x6a09e667UL;c->state[1]=0xbb67ae85UL;c->state[2]=0x3c6ef372UL;c->state[3]=0xa54ff53aUL;
    c->state[4]=0x510e527fUL;c->state[5]=0x9b05688cUL;c->state[6]=0x1f83d9abUL;c->state[7]=0x5be0cd19UL;
    c->count_lo=c->count_hi=0;
}
void w98_sha256_update(W98_SHA256_CTX *c,const void *vp,unsigned long n) {
    const w98_u8 *p=(const w98_u8*)vp; unsigned long used,free_n,take,old;
    used=(c->count_lo>>3)&63; old=c->count_lo; c->count_lo+=(w98_u32)(n<<3);
    if(c->count_lo<old)c->count_hi++; c->count_hi+=(w98_u32)(n>>29);
    while(n){free_n=64-used;take=n<free_n?n:free_n;memcpy(c->buffer+used,p,take);
      used+=take;p+=take;n-=take;if(used==64){transform(c,c->buffer);used=0;}}
}
void w98_sha256_final(W98_SHA256_CTX *c,w98_u8 out[32]) {
    w98_u8 pad[64],len[8]; unsigned long used,pad_n; int i;
    memset(pad,0,sizeof(pad));pad[0]=0x80;put32(len,c->count_hi);put32(len+4,c->count_lo);
    used=(c->count_lo>>3)&63;pad_n=used<56?56-used:120-used;
    w98_sha256_update(c,pad,pad_n);w98_sha256_update(c,len,8);
    for(i=0;i<8;i++)put32(out+i*4,c->state[i]);memset(c,0,sizeof(*c));
}
