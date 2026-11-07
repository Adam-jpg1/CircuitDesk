/* Differential test for the ARMv7-M core: the same program is compiled for the
 * host and for the Cortex-M, and both must print exactly the same thing. It
 * avoids anything whose result is implementation-defined between the two C
 * libraries (transcendental libm functions, long double, char signedness). */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <setjmp.h>
#include <math.h>

static uint32_t seed = 0x12345678u;
static uint32_t rnd(void) { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return seed; }

static uint32_t hash = 2166136261u;
static uint32_t fmahash = 2166136261u;
static void mix(uint32_t v) { hash = (hash ^ v) * 16777619u; }
static void mix64(uint64_t v) { mix((uint32_t)v); mix((uint32_t)(v >> 32)); }

struct bits { unsigned a : 3; unsigned b : 7; signed c : 5; unsigned d : 17; };

static int classify(int x) {
  switch (x) {
    case 0: return 11; case 1: return 23; case 2: return 5; case 3: return 99; case 4: return 7;
    case 5: return 1; case 6: return 42; case 7: return 13; case 8: return 77; case 9: return 3;
    case 10: return 64; case 11: return 8; case 12: return 31; case 13: return 2; default: return -1;
  }
}

static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

static jmp_buf jb;
static void jumper(int depth) { if (depth == 0) longjmp(jb, 42); jumper(depth - 1); }

static int cmp(const void *a, const void *b) { int x = *(const int *)a, y = *(const int *)b; return (x > y) - (x < y); }

__attribute__((noinline)) static float fpoly(float x) { float r = 0; for (int i = 0; i < 12; i++) r = r * x + (float)(i * 3 - 7) / 5.0f; return r; }
__attribute__((noinline)) static double dpoly(double x) { double r = 0; for (int i = 0; i < 12; i++) r = r * x + (double)(i * 3 - 7) / 5.0; return r; }

int main(void) {
  /* 32-bit integer arithmetic */
  for (int i = 0; i < 4000; i++) {
    uint32_t a = rnd(), b = rnd(), c = rnd() & 31;
    int32_t sa = (int32_t)a, sb = (int32_t)b;
    mix(a + b); mix(a - b); mix(a * b); mix(a & ~b); mix(a | b); mix(a ^ b);
    mix(a << c); mix(a >> c); mix((uint32_t)(sa >> c)); mix((a >> c) | (a << ((32 - c) & 31)));
    if (b) { mix(a / b); mix(a % b); }
    if (sb && !(sa == INT32_MIN && sb == -1)) { mix((uint32_t)(sa / sb)); mix((uint32_t)(sa % sb)); }
    uint32_t small = (b & 0xff) + 1; mix(a / small); mix((uint32_t)(sa / (int32_t)small));
    mix(a > b); mix(sa > sb); mix(a >= b); mix(sa <= sb);
    mix(__builtin_clz(a | 1)); mix(__builtin_ctz(a | 0x80000000u)); mix(__builtin_popcount(a));
    mix(__builtin_bswap32(a)); mix((uint16_t)__builtin_bswap16((uint16_t)a));
    mix((uint32_t)(int8_t)a); mix((uint32_t)(int16_t)a); mix((uint8_t)a); mix((uint16_t)a);
    mix(sa < 0 ? -sa : sa);
    mix(a > b ? a : b); mix(sa < sb ? sa : sb);
  }
  printf("int32 %08lx\n", (unsigned long)hash);

  /* 64-bit */
  hash = 2166136261u;
  for (int i = 0; i < 2000; i++) {
    uint64_t a = ((uint64_t)rnd() << 32) | rnd(), b = ((uint64_t)rnd() << 32) | rnd();
    int64_t sa = (int64_t)a, sb = (int64_t)b;
    mix64(a + b); mix64(a - b); mix64(a * b); mix64(a >> (i & 63)); mix64(a << (i & 63)); mix64((uint64_t)(sa >> (i & 63)));
    if (b) { mix64(a / b); mix64(a % b); }
    uint64_t d = (b >> (i & 31)) | 1; mix64(a / d); mix64(a % d);
    if (sb && !(sa == INT64_MIN && sb == -1)) { mix64((uint64_t)(sa / sb)); mix64((uint64_t)(sa % sb)); }
    uint32_t x = (uint32_t)a, y = (uint32_t)b;
    mix64((uint64_t)x * y); mix64((uint64_t)((int64_t)(int32_t)x * (int32_t)y));
    mix64((uint64_t)x * y + (uint64_t)(uint32_t)(a >> 32));
    mix(a > b); mix(sa < sb);
  }
  printf("int64 %08lx\n", (unsigned long)hash);

  /* bitfields, switch tables, recursion, setjmp */
  hash = 2166136261u;
  struct bits bf;
  memset(&bf, 0, sizeof bf);
  for (int i = 0; i < 500; i++) {
    uint32_t r = rnd();
    bf.a = r; bf.b = r >> 3; bf.c = (int)(r >> 10); bf.d = r >> 15;
    mix(bf.a); mix(bf.b); mix((uint32_t)bf.c); mix(bf.d);
    bf.b += bf.a; bf.c -= 3; mix(bf.b); mix((uint32_t)bf.c);
    mix((uint32_t)classify((int)(r % 17)));
  }
  mix((uint32_t)fib(20));
  int jv = setjmp(jb);
  if (jv == 0) jumper(10);
  mix((uint32_t)jv);
  printf("misc %08lx\n", (unsigned long)hash);

  /* libc: sort, format, parse */
  int arr[64];
  for (int i = 0; i < 64; i++) arr[i] = (int)(rnd() % 2001) - 1000;
  qsort(arr, 64, sizeof arr[0], cmp);
  hash = 2166136261u;
  for (int i = 0; i < 64; i++) mix((uint32_t)arr[i]);
  char buf[128];
  snprintf(buf, sizeof buf, "%d|%u|%x|%08X|%-5d|%+d|%c|%s", -12345, 4000000000u, 0xbeef, 0xC0FFEEu, 7, 99, 'Q', "str");
  printf("libc %08lx %s\n", (unsigned long)hash, buf);
  printf("strtol %ld %lu %ld\n", strtol("-123456", 0, 10), strtoul("ffff", 0, 16), strtol("0777", 0, 0));

  /* single precision */
  hash = 2166136261u;
  float facc = 0;
  for (int i = 0; i < 3000; i++) {
    float a = (float)(int32_t)rnd() / 65536.0f, b = (float)(int32_t)rnd() / 1048576.0f;
    float s = a + b, d = a - b, m = a * b, q = b != 0 ? a / b : 0;
    union { float f; uint32_t u; } u;
    u.f = s; mix(u.u); u.f = d; mix(u.u); u.f = m; mix(u.u); u.f = q; mix(u.u);
    u.f = sqrtf(fabsf(a)); mix(u.u);
    u.f = fmaf(a, b, s); mix(u.u);
    mix((uint32_t)(int32_t)a); mix((uint32_t)(int32_t)q);
    mix(a < b); mix(a == b);
    u.f = (float)(uint32_t)rnd(); mix(u.u);
    u.f = (float)(int32_t)rnd(); mix(u.u);
    facc += m * 1e-6f;
  }
  {
    union { float f; uint32_t u; } u; u.f = facc; mix(u.u); u.f = fpoly(1.25f); mix(u.u);
    u.f = floorf(-2.5f); mix(u.u); u.f = ceilf(2.25f); mix(u.u); u.f = roundf(-3.5f); mix(u.u); u.f = truncf(-7.9f); mix(u.u);
  }
  printf("f32 %08lx\n", (unsigned long)hash);

  /* double precision */
  hash = 2166136261u;
  double dacc = 0;
  for (int i = 0; i < 2000; i++) {
    double a = (double)(int32_t)rnd() / 65536.0, b = (double)(int32_t)rnd() / 1048576.0;
    double s = a + b, d = a - b, m = a * b, q = b != 0 ? a / b : 0;
    union { double f; uint64_t u; } u;
    u.f = s; mix64(u.u); u.f = d; mix64(u.u); u.f = m; mix64(u.u); u.f = q; mix64(u.u);
    u.f = sqrt(fabs(a)); mix64(u.u);
    { uint32_t h = hash; hash = fmahash; u.f = fma(a, b, s); mix64(u.u); fmahash = hash; hash = h; }
    mix((uint32_t)(int32_t)a); mix((uint32_t)(int64_t)(q * 1000));
    u.f = (double)(uint64_t)(((uint64_t)rnd() << 32) | rnd()); mix64(u.u);
    { union { float f; uint32_t u; } v; v.f = (float)a; mix(v.u); v.f = (float)q; mix(v.u); }
    dacc += m * 1e-9;
  }
  {
    union { double f; uint64_t u; } u; u.f = dacc; mix64(u.u); u.f = dpoly(1.25); mix64(u.u);
    u.f = floor(-2.5); mix64(u.u); u.f = ceil(2.25); mix64(u.u); u.f = round(-3.5); mix64(u.u); u.f = trunc(-7.9); mix64(u.u);
  }
  printf("f64 %08lx\n", (unsigned long)hash);
  /* newlib's fma() is only fused where the hardware has a double FMA; its
   * software version rounds twice. The test leaves this line out there. */
  printf("fma64 %08lx\n", (unsigned long)fmahash);
  snprintf(buf, sizeof buf, "%.17g %.9g %e %f", 3.14159265358979, (double)2.7182817f, 6.02214076e23, -0.000123);
  printf("fmt %s\n", buf);
  printf("strtod %.17g %.17g\n", strtod("1.0000000000000002", 0), strtod("-6.25e-3", 0));
  printf("done\n");
  return 0;
}
