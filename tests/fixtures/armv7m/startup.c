/* Bare-metal startup for the core tests: vector table, .data/.bss setup, FPU
 * enable, and newlib syscalls that write to a test UART at 0x40000000. */
#include <stdint.h>
#include <sys/stat.h>
#include <errno.h>

#define TEST_OUT  (*(volatile uint32_t *)0x40000000)
#define TEST_EXIT (*(volatile uint32_t *)0x40000004)

extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss, _estack, _end;
int main(void);
void Reset_Handler(void);
void Default_Handler(void) { TEST_EXIT = 0xdead; for (;;) {} }
void NMI_Handler(void) __attribute__((weak, alias("Default_Handler")));
void HardFault_Handler(void) __attribute__((weak, alias("Default_Handler")));
void SVC_Handler(void) __attribute__((weak, alias("Default_Handler")));
void PendSV_Handler(void) __attribute__((weak, alias("Default_Handler")));
void SysTick_Handler(void) __attribute__((weak, alias("Default_Handler")));
void IRQ0_Handler(void) __attribute__((weak, alias("Default_Handler")));
void IRQ1_Handler(void) __attribute__((weak, alias("Default_Handler")));
void IRQ2_Handler(void) __attribute__((weak, alias("Default_Handler")));

__attribute__((section(".isr_vector"), used)) void (*const vectors[])(void) = {
  (void (*)(void))&_estack, Reset_Handler, NMI_Handler, HardFault_Handler, Default_Handler, Default_Handler,
  Default_Handler, 0, 0, 0, 0, SVC_Handler, Default_Handler, 0, PendSV_Handler, SysTick_Handler,
  IRQ0_Handler, IRQ1_Handler, IRQ2_Handler,
};

void Reset_Handler(void) {
  uint32_t *src = &_sidata, *dst = &_sdata;
  while (dst < &_edata) *dst++ = *src++;
  for (dst = &_sbss; dst < &_ebss;) *dst++ = 0;
#if defined(__ARM_FP)
  *(volatile uint32_t *)0xE000ED88 |= 0xF << 20;
  __asm volatile("dsb\n isb");
#endif
  int rc = main();
  TEST_EXIT = (uint32_t)rc;
  for (;;) {}
}

int _write(int fd, const char *p, int n) { (void)fd; for (int i = 0; i < n; i++) TEST_OUT = (uint8_t)p[i]; return n; }
int _read(int fd, char *p, int n) { (void)fd; (void)p; (void)n; return 0; }
int _close(int fd) { (void)fd; return -1; }
int _lseek(int fd, int o, int w) { (void)fd; (void)o; (void)w; return 0; }
int _fstat(int fd, struct stat *st) { (void)fd; st->st_mode = S_IFCHR; return 0; }
int _isatty(int fd) { (void)fd; return 1; }
int _getpid(void) { return 1; }
int _kill(int p, int s) { (void)p; (void)s; return -1; }
void _exit(int rc) { TEST_EXIT = (uint32_t)rc; for (;;) {} }
void *_sbrk(int incr) {
  static char *heap = (char *)&_end;
  char *prev = heap;
  heap += incr;
  return prev;
}
