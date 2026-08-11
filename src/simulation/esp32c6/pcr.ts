// The ESP32-C6's PCR, the clock and reset controller.
//
// The C6 replaces the C3's SYSTEM block with this one, at a different address
// and with an entirely different register set. It is not a register file that
// starts at zero, and treating it as one is how a C6 aborts during startup:
//
//   assert failed: spimem_flash_ll_get_source_freq_mhz
//   hal/esp32c6/include/hal/spimem_flash_ll.h:648 (false)
//
// That function reads PCR_MSPI_CLK_CONF_REG to work out how fast the flash bus
// is running and asserts when the divider is not one of the values the hardware
// can be in. Its reset value is 3, not 0 — so a zeroed register reports a
// divider the chip cannot have, and the firmware quite correctly refuses to
// believe it.
//
// Seventy-six of these registers have a documented non-zero reset value, and
// several of them are read-only fields the firmware treats as facts about the
// chip rather than settings: PCR_CLK_XTAL_FREQ reports 40, so a zeroed register
// would tell the firmware it has no crystal. Every value below was read from
// `soc/esp32c6/register/soc/pcr_reg.h` in the same core the firmware was built
// with, and each carries the field names that produce it.

import { RegisterFile } from '../esp32c3/registerFile';

export const PCR_BASE = 0x60096000;

/**
 * Documented reset values, by register offset.
 *
 * Registers not listed reset to zero, which the register file already does.
 */
export const PCR_RESET_VALUES: readonly (readonly [number, number])[] = [
  [0x000, 0x00000001], // UART0_CONF: UART0_CLK_EN=1
  [0x004, 0x00700000], // UART0_SCLK_CONF: UART0_SCLK_SEL=3, UART0_SCLK_EN=1
  [0x008, 0x00000002], // UART0_PD_CTRL: UART0_MEM_FORCE_PU=1
  [0x00c, 0x00000001], // UART1_CONF: UART1_CLK_EN=1
  [0x010, 0x00700000], // UART1_SCLK_CONF: UART1_SCLK_SEL=3, UART1_SCLK_EN=1
  [0x014, 0x00000002], // UART1_PD_CTRL: UART1_MEM_FORCE_PU=1
  [0x018, 0x00000005], // MSPI_CONF: MSPI_CLK_EN=1, MSPI_PLL_CLK_EN=1
  [0x01c, 0x00000300], // MSPI_CLK_CONF: MSPI_FAST_HS_DIV_NUM=3
  [0x020, 0x00000001], // I2C_CONF: I2C_CLK_EN=1
  [0x024, 0x00400000], // I2C_SCLK_CONF: I2C_SCLK_EN=1
  [0x028, 0x00000001], // UHCI_CONF: UHCI_CLK_EN=1
  [0x02c, 0x00000001], // RMT_CONF: RMT_CLK_EN=1
  [0x030, 0x00501000], // RMT_SCLK_CONF: RMT_SCLK_DIV_NUM=1, RMT_SCLK_SEL=1, RMT_SCLK_EN=1
  [0x034, 0x00000001], // LEDC_CONF: LEDC_CLK_EN=1
  [0x038, 0x00400000], // LEDC_SCLK_CONF: LEDC_SCLK_EN=1
  [0x03c, 0x00000001], // TIMERGROUP0_CONF: TG0_CLK_EN=1
  [0x040, 0x00400000], // TIMERGROUP0_TIMER_CLK_CONF: TG0_TIMER_CLK_EN=1
  [0x044, 0x00400000], // TIMERGROUP0_WDT_CLK_CONF: TG0_WDT_CLK_EN=1
  [0x048, 0x00000001], // TIMERGROUP1_CONF: TG1_CLK_EN=1
  [0x04c, 0x00400000], // TIMERGROUP1_TIMER_CLK_CONF: TG1_TIMER_CLK_EN=1
  [0x050, 0x00400000], // TIMERGROUP1_WDT_CLK_CONF: TG1_WDT_CLK_EN=1
  [0x054, 0x00000001], // SYSTIMER_CONF: SYSTIMER_CLK_EN=1
  [0x058, 0x00400000], // SYSTIMER_FUNC_CLK_CONF: SYSTIMER_FUNC_CLK_EN=1
  [0x05c, 0x00000001], // TWAI0_CONF: TWAI0_CLK_EN=1
  [0x060, 0x00400000], // TWAI0_FUNC_CLK_CONF: TWAI0_FUNC_CLK_EN=1
  [0x064, 0x00000001], // TWAI1_CONF: TWAI1_CLK_EN=1
  [0x068, 0x00400000], // TWAI1_FUNC_CLK_CONF: TWAI1_FUNC_CLK_EN=1
  [0x06c, 0x00000001], // I2S_CONF: I2S_CLK_EN=1
  [0x070, 0x00402000], // I2S_TX_CLKM_CONF: I2S_TX_CLKM_DIV_NUM=2, I2S_TX_CLKM_EN=1
  [0x074, 0x00000200], // I2S_TX_CLKM_DIV_CONF: I2S_TX_CLKM_DIV_Y=1
  [0x078, 0x00402000], // I2S_RX_CLKM_CONF: I2S_RX_CLKM_DIV_NUM=2, I2S_RX_CLKM_EN=1
  [0x07c, 0x00000200], // I2S_RX_CLKM_DIV_CONF: I2S_RX_CLKM_DIV_Y=1
  [0x080, 0x00000005], // SARADC_CONF: SARADC_CLK_EN=1, SARADC_REG_CLK_EN=1
  [0x084, 0x00404000], // SARADC_CLKM_CONF: SARADC_CLKM_DIV_NUM=4, SARADC_CLKM_EN=1
  [0x088, 0x00400000], // TSENS_CLK_CONF: TSENS_CLK_EN=1
  [0x08c, 0x00000001], // USB_DEVICE_CONF: USB_DEVICE_CLK_EN=1
  [0x090, 0x00000001], // INTMTX_CONF: INTMTX_CLK_EN=1
  [0x094, 0x00000001], // PCNT_CONF: PCNT_CLK_EN=1
  [0x098, 0x00000001], // ETM_CONF: ETM_CLK_EN=1
  [0x09c, 0x00000001], // PWM_CONF: PWM_CLK_EN=1
  [0x0a0, 0x00404000], // PWM_CLK_CONF: PWM_DIV_NUM=4, PWM_CLKM_EN=1
  [0x0a4, 0x00000001], // PARL_IO_CONF: PARL_CLK_EN=1
  [0x0a8, 0x00040000], // PARL_CLK_RX_CONF: PARL_CLK_RX_EN=1
  [0x0ac, 0x00040000], // PARL_CLK_TX_CONF: PARL_CLK_TX_EN=1
  [0x0b0, 0x00000001], // SDIO_SLAVE_CONF: SDIO_SLAVE_CLK_EN=1
  [0x0b4, 0x0000001d], // PVT_MONITOR_CONF: PVT_MONITOR_CLK_EN=1, PVT_MONITOR_SITE1_CLK_EN=1, PVT_MONITOR_SITE2_CLK_EN=1, PVT_MONITOR_SITE3_CLK_EN=1
  [0x0b8, 0x00400000], // PVT_MONITOR_FUNC_CLK_CONF: PVT_MONITOR_FUNC_CLK_EN=1
  [0x0bc, 0x00000001], // GDMA_CONF: GDMA_CLK_EN=1
  [0x0c0, 0x00000001], // SPI2_CONF: SPI2_CLK_EN=1
  [0x0c4, 0x00400000], // SPI2_CLKM_CONF: SPI2_CLKM_EN=1
  [0x0c8, 0x00000001], // AES_CONF: AES_CLK_EN=1
  [0x0cc, 0x00000001], // SHA_CONF: SHA_CLK_EN=1
  [0x0d0, 0x00000001], // RSA_CONF: RSA_CLK_EN=1
  [0x0d4, 0x00000002], // RSA_PD_CTRL: RSA_MEM_FORCE_PU=1
  [0x0d8, 0x00000001], // ECC_CONF: ECC_CLK_EN=1
  [0x0dc, 0x00000002], // ECC_PD_CTRL: ECC_MEM_FORCE_PU=1
  [0x0e0, 0x00000001], // DS_CONF: DS_CLK_EN=1
  [0x0e4, 0x00000001], // HMAC_CONF: HMAC_CLK_EN=1
  [0x0e8, 0x00000001], // IOMUX_CONF: IOMUX_CLK_EN=1
  [0x0ec, 0x00700000], // IOMUX_CLK_CONF: IOMUX_FUNC_CLK_SEL=3, IOMUX_FUNC_CLK_EN=1
  [0x0f0, 0x00000001], // MEM_MONITOR_CONF: MEM_MONITOR_CLK_EN=1
  [0x0fc, 0x00000001], // TRACE_CONF: TRACE_CLK_EN=1
  [0x100, 0x00000001], // ASSIST_CONF: ASSIST_CLK_EN=1
  [0x104, 0x00000001], // CACHE_CONF: CACHE_CLK_EN=1
  [0x108, 0x00000001], // MODEM_APB_CONF: MODEM_APB_CLK_EN=1
  [0x110, 0x28000200], // SYSCLK_CONF: HS_DIV_NUM=2, CLK_XTAL_FREQ=40
  [0x114, 0x0000000d], // CPU_WAITI_CONF: CPUPERIOD_SEL=1, PLL_FREQ_SEL=1, CPU_WAIT_MODE_FORCE_ON=1
  [0x11c, 0x00000300], // AHB_FREQ_CONF: AHB_HS_DIV_NUM=3
  [0x124, 0x0001e014], // SYSCLK_FREQ_QUERY_0: FOSC_FREQ=20, PLL_FREQ=480
  [0x128, 0x0000007f], // PLL_DIV_CLK_EN: PLL_240M_CLK_EN=1, PLL_160M_CLK_EN=1, PLL_120M_CLK_EN=1, PLL_80M_CLK_EN=1, PLL_48M_CLK_EN=1, PLL_40M_CLK_EN=1, PLL_20M_CLK_EN=1
  [0x12c, 0x000007ff], // CTRL_CLK_OUT_EN: CLK20_OEN=1, CLK22_OEN=1, CLK44_OEN=1, CLK_BB_OEN=1, CLK80_OEN=1, CLK160_OEN=1, CLK_320M_OEN=1, CLK_ADC_INF_OEN=1, CLK_DAC_CPU_OEN=1, CLK40X_BB_OEN=1, CLK_XTAL_OEN=1
  [0x130, 0x00010727], // CTRL_TICK_CONF: XTAL_TICK_NUM=39, FOSC_TICK_NUM=7, TICK_ENABLE=1
  [0x138, 0x0000700f], // SRAM_POWER_CONF: SRAM_FORCE_PU=15, ROM_FORCE_PU=7
  [0xff0, 0x00000002], // RESET_EVENT_BYPASS: RESET_EVENT_BYPASS=1
  [0xff4, 0xffffffff], // FPGA_DEBUG: FPGA_DEBUG=4294967295
  [0xffc, 0x02206150], // DATE: DATE=35676496
];

/**
 * Clock and reset control.
 *
 * Everything here is a configuration register that holds what firmware wrote —
 * this runtime does not gate a peripheral off when its clock-enable bit is
 * cleared, and does not claim to. What it does do is start from the state the
 * silicon starts in, so a firmware that reads a divider it never set gets the
 * chip's answer rather than zero.
 */
export class Esp32C6Pcr extends RegisterFile {
  constructor() {
    super('pcr', PCR_BASE, 0x1000);
    this.reset();
  }

  override reset(): void {
    super.reset();
    for (const [offset, value] of PCR_RESET_VALUES) this.registers.set(offset, value >>> 0);
  }
}
