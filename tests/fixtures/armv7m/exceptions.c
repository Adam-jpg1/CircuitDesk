/* ARM-only: exceptions, priorities, stacks and the system control space. */
#include <stdio.h>
#include <stdint.h>

#define REG(a) (*(volatile uint32_t *)(a))
#define SYST_CSR REG(0xE000E010)
#define SYST_RVR REG(0xE000E014)
#define SYST_CVR REG(0xE000E018)
#define NVIC_ISER0 REG(0xE000E100)
#define NVIC_ISPR0 REG(0xE000E200)
#define NVIC_IPR(n) (*(volatile uint8_t *)(0xE000E400 + (n)))
#define SCB_ICSR REG(0xE000ED04)
#define SCB_SHPR3 REG(0xE000ED20)
#define DWT_CTRL REG(0xE0001000)
#define DWT_CYCCNT REG(0xE0001004)
#define DEMCR REG(0xE000EDFC)

static volatile uint32_t ticks, svc_calls, pendsv_calls, irq0_calls, irq1_calls, order[8], order_n, svc_arg;
static volatile uint32_t nested_seen;
#if defined(__ARM_FP)
static volatile float fp_in_irq;
#endif

void SysTick_Handler(void) { ticks++; }
void PendSV_Handler(void) { pendsv_calls++; order[order_n++] = 14; }
void IRQ1_Handler(void) { irq1_calls++; order[order_n++] = 17; }
void IRQ0_Handler(void) {
  irq0_calls++;
  order[order_n++] = 16;
  /* Pend a higher-priority interrupt from inside: it must preempt now. */
  NVIC_ISPR0 = 1u << 1;
  nested_seen = irq1_calls;
#if defined(__ARM_FP)
  volatile float x = 1.5f; for (int i = 0; i < 5; i++) x = x * 1.25f + 0.5f; fp_in_irq = x;
#endif
}

__attribute__((naked)) void SVC_Handler(void) {
  __asm volatile(
    "tst lr, #4\n ite eq\n mrseq r0, msp\n mrsne r0, psp\n"
    "ldr r1, [r0, #24]\n ldrb r1, [r1, #-2]\n"   /* the SVC immediate */
    "ldr r2, =svc_arg\n str r1, [r2]\n"
    "ldr r2, =svc_calls\n ldr r3, [r2]\n adds r3, #1\n str r3, [r2]\n"
    "ldr r1, [r0]\n adds r1, #100\n str r1, [r0]\n" /* return r0 + 100 */
    "bx lr\n");
}

static int svc_add100(int v) {
  register int r0 __asm("r0") = v;
  __asm volatile("svc #42" : "+r"(r0) : : "memory");
  return r0;
}

static uint32_t psp_stack[256];

int main(void) {
  /* SysTick: 1000-cycle period, interrupt on, core clock. */
  SYST_RVR = 999; SYST_CVR = 0; SYST_CSR = 7;
  while (ticks < 20) {}
  SYST_CSR = 0;
  printf("systick %lu\n", (unsigned long)(ticks >= 20));

  printf("svc %d %lu %lu\n", svc_add100(5), (unsigned long)svc_calls, (unsigned long)svc_arg);

  /* PendSV from thread mode is taken at once. */
  SCB_ICSR = 1u << 28;
  __asm volatile("dsb\n isb");
  printf("pendsv %lu\n", (unsigned long)pendsv_calls);

  /* NVIC: IRQ1 has the higher priority (lower number) and preempts IRQ0. */
  NVIC_IPR(0) = 0x80; NVIC_IPR(1) = 0x40;
  NVIC_ISER0 = 3;
  order_n = 0;
  NVIC_ISPR0 = 1;
  __asm volatile("dsb\n isb");
  printf("nvic %lu %lu nested=%lu order=%lu,%lu\n", (unsigned long)irq0_calls, (unsigned long)irq1_calls,
         (unsigned long)nested_seen, (unsigned long)order[0], (unsigned long)order[1]);

  /* PRIMASK holds a pending interrupt off until it is cleared. */
  __asm volatile("cpsid i");
  NVIC_ISPR0 = 2;
  __asm volatile("dsb\n isb");
  uint32_t before = irq1_calls;
  __asm volatile("cpsie i");
  __asm volatile("dsb\n isb");
  printf("primask %lu %lu\n", (unsigned long)before, (unsigned long)irq1_calls);

  /* BASEPRI masks IRQ0 (0x80) but not IRQ1 (0x40). */
  __asm volatile("msr basepri, %0" : : "r"(0x80));
  NVIC_ISPR0 = 3;
  __asm volatile("dsb\n isb");
  uint32_t i0 = irq0_calls, i1 = irq1_calls;
  __asm volatile("msr basepri, %0" : : "r"(0));
  __asm volatile("dsb\n isb");
  printf("basepri %lu %lu -> %lu %lu\n", (unsigned long)i0, (unsigned long)i1, (unsigned long)irq0_calls, (unsigned long)irq1_calls);

  /* Thread mode on the process stack; an SVC from there returns to it. */
  uint32_t top = (uint32_t)&psp_stack[256];
  __asm volatile("msr psp, %0\n mov r0, #2\n msr control, r0\n isb" : : "r"(top) : "r0");
  uint32_t sp; __asm volatile("mov %0, sp" : "=r"(sp));
  int r = svc_add100(1);
  uint32_t ctrl; __asm volatile("mrs %0, control" : "=r"(ctrl));
  __asm volatile("mov r0, #0\n msr control, r0\n isb" : : : "r0");
  printf("psp %d %d ctrl=%lu\n", sp > (uint32_t)psp_stack && sp <= top, r, (unsigned long)(ctrl & 2));

  /* Exclusive access. */
  static volatile uint32_t word = 5;
  uint32_t v, fail;
  __asm volatile("ldrex %0, [%2]\n add %0, %0, #1\n strex %1, %0, [%2]" : "=&r"(v), "=&r"(fail) : "r"(&word) : "memory");
  printf("ldrex %lu %lu\n", (unsigned long)word, (unsigned long)fail);
  __asm volatile("ldrex %0, [%2]\n clrex\n strex %1, %0, [%2]" : "=&r"(v), "=&r"(fail) : "r"(&word) : "memory");
  printf("clrex %lu\n", (unsigned long)fail);

#if !defined(__ARM_ARCH_7EM__) || !defined(CORE_M7)
  /* Bit-banding (M3/M4): set bit 5 of a RAM word through its alias. */
  static volatile uint32_t bb = 0;
  uint32_t alias = 0x22000000 + (((uint32_t)&bb - 0x20000000) * 32) + 5 * 4;
  *(volatile uint32_t *)alias = 1;
  printf("bitband %lu %lu\n", (unsigned long)bb, (unsigned long)*(volatile uint32_t *)alias);
#endif

  /* DWT cycle counter runs. */
  DEMCR |= 1u << 24; DWT_CYCCNT = 0; DWT_CTRL |= 1;
  uint32_t c0 = DWT_CYCCNT; for (volatile int k = 0; k < 100; k++) {} uint32_t c1 = DWT_CYCCNT;
  printf("dwt %d\n", c1 - c0 > 100);

  /* WFI with SysTick armed wakes. */
  ticks = 0; SYST_RVR = 499; SYST_CVR = 0; SYST_CSR = 7;
  __asm volatile("wfi");
  SYST_CSR = 0;
  printf("wfi %d\n", ticks >= 1);

#if defined(__ARM_FP)
  /* FP registers survive an interrupt that uses the FPU. */
  volatile float a = 3.0f, b = 7.0f;
  float s = a * b;
  NVIC_ISPR0 = 1;
  __asm volatile("dsb\n isb");
  float t = s + a;
  printf("fpctx %d %d\n", (int)t, (int)(fp_in_irq * 1000));
#endif
  printf("done\n");
  return 0;
}
