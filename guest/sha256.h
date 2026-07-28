#ifndef W98_SHA256_H
#define W98_SHA256_H

typedef unsigned char w98_u8;
typedef unsigned long w98_u32;

typedef struct {
    w98_u32 state[8];
    w98_u32 count_lo;
    w98_u32 count_hi;
    w98_u8 buffer[64];
} W98_SHA256_CTX;

void w98_sha256_init(W98_SHA256_CTX *ctx);
void w98_sha256_update(W98_SHA256_CTX *ctx, const void *data, unsigned long len);
void w98_sha256_final(W98_SHA256_CTX *ctx, w98_u8 out[32]);
void w98_hmac_sha256(const w98_u8 *key, unsigned long key_len,
                     const void *a, unsigned long a_len,
                     const void *b, unsigned long b_len,
                     const void *c, unsigned long c_len,
                     w98_u8 out[32]);

#endif
