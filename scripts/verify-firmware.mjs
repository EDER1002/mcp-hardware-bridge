#!/usr/bin/env node
/**
 * Verificación estática del firmware Kraken (MiniSumo) contra el informe PDF.
 *
 * Comprueba, sin hardware:
 *   - Mapa de pines = Tabla 4 del Informe_MiniSumo_Kraken (hoja 6).
 *   - Invariantes de seguridad: motores apagados al encender, 5 s reglamentarios,
 *     escape del borde con prioridad, máscara VL53L0X 0x07, watchdog, etc.
 *
 * Uso:
 *   node scripts/verify-firmware.mjs /ruta/a/Kraken_v3_2_FINAL.ino
 *
 * Salida: un PASS/FAIL por chequeo; exit 1 si alguno falla.
 * Esto NO sustituye una prueba en placa: solo valida el texto del .ino.
 */
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("Uso: node scripts/verify-firmware.mjs <archivo.ino>");
  process.exit(2);
}

const src = await readFile(path, "utf8");

// Extrae el cuerpo de una función "void nombre(...)" hasta la siguiente "void ".
// Ignora prototipos (líneas terminadas en ";") y se queda con la definición.
function bodyOf(fnName) {
  const needle = `void ${fnName}(`;
  let idx = src.indexOf(needle);
  while (idx !== -1) {
    const lineEnd = src.indexOf("\n", idx);
    const line = src.slice(idx, lineEnd === -1 ? undefined : lineEnd);
    if (!line.trimEnd().endsWith(";")) {
      let end = src.indexOf("\nvoid ", idx + 1);
      if (end === -1) end = src.length;
      return src.slice(idx, end);
    }
    idx = src.indexOf(needle, idx + 1);
  }
  return null;
}

const setupBody = bodyOf("setup");
const loopBody = bodyOf("loop");
const cuentaBody = bodyOf("iniciarCuenta");
const esperaBody = bodyOf("estadoEspera");

const results = [];
function check(name, ok) {
  results.push({ name, ok: Boolean(ok) });
}

// ---------------------------------------------------------------- pinout (PDF, Tabla 4)
check("XSHUT en D2/D3/D4/A2/A3",      /PIN_XSHUT\[N_SENSORES\]\s*=\s*\{\s*2,\s*3,\s*4,\s*A2,\s*A3\s*\}/.test(src));
check("direcciones I2C 0x30..0x34",   /DIR_I2C\[N_SENSORES\]\s*=\s*\{\s*0x30,\s*0x31,\s*0x32,\s*0x33,\s*0x34\s*\}/.test(src));
check("QTR-1A en A0/A1",              /PIN_QTR_IZQ\s*=\s*A0/.test(src) && /PIN_QTR_DER\s*=\s*A1/.test(src));
check("batería en A6",                /PIN_VBAT\s*=\s*A6/.test(src));
check("canal A (izq): D7/D8/D9",      /PIN_AIN1\s*=\s*7/.test(src) && /PIN_AIN2\s*=\s*8/.test(src) && /PIN_PWMA\s*=\s*9/.test(src));
check("canal B (der): D5/D6/D10",     /PIN_BIN1\s*=\s*5/.test(src) && /PIN_BIN2\s*=\s*6/.test(src) && /PIN_PWMB\s*=\s*10/.test(src));
check("STBY en D11",                  /PIN_STBY\s*=\s*11/.test(src));
check("pulsador en D12",              /PIN_BTN\s*=\s*12/.test(src));

// ---------------------------------------------------------------- seguridad
check("setup: STBY en LOW al arrancar", setupBody !== null && /digitalWrite\(PIN_STBY,\s*LOW\)/.test(setupBody));
check("setup: sin comandos de motor", setupBody !== null &&
  !/habilitarMotores\(/.test(setupBody) && !/\bmotores\(/.test(setupBody) &&
  !/avanzar\(/.test(setupBody) && !/girar\(/.test(setupBody));
check("cuenta: 5000 ms reglamentarios", /T_CUENTA_MS\s*=\s*5000/.test(src));
check("cuenta: empieza con motores apagados (detener)", cuentaBody !== null && /detener\(\)/.test(cuentaBody));
check("loop: sin delay() bloqueante", loopBody !== null && !/\bdelay\(/.test(loopBody));

// Escape del borde con prioridad sobre apertura/búsqueda/ataque
check("escape: prioridad sobre APERTURA/BUSQUEDA/ATAQUE",
  /\(estado == ST_APERTURA \|\| estado == ST_BUSQUEDA \|\| estado == ST_ATAQUE\) && lineaBlanca\(\)/.test(src));

// ---------------------------------------------------------------- correcciones v3.2
check("VL53L0X: máscara de interrupción 0x07", /\(st & 0x07\) == 0/.test(src) && !/\(st & 0x01\)/.test(src));
check("recuperación de láseres desactivada por defecto", /RECUPERACION_LASER\s*=\s*false/.test(src));
check("recuperación solo se invoca desde ESPERA", esperaBody !== null && /reiniciarLaseres\(\)/.test(esperaBody));
check("recuperación reconstruye el objeto VL53L0X (vuelve a 0x29)", /laser\[i\]\s*=\s*VL53L0X\(\)/.test(src));
check("recuperación verifica dirección de fábrica 0x29", /i2cPresente\(0x29\)/.test(src));
check("torero engancha a 350 mm", /TORERO_ENGAGE_MM\s*=\s*350/.test(src));
check("watchdog: limpieza en .init3 antes de setup", /\.init3/.test(src) && /wdt_disable\(\)/.test(src));
check("watchdog: habilitado a 4 s", /wdt_enable\(WDTO_4S\)/.test(src));
check("watchdog: alimentado en cada vuelta del loop", loopBody !== null && /wdt_reset\(\)/.test(loopBody));
// EWMA entera: forma exacta (3f + r) >> 2, o la aproximación antigua f - f/4 + r/4
const ewmaOk = /\(uint32_t\)lineaFiltrada\[i\]\s*\*\s*3u?\s*\+\s*lineaRaw\[i\]\)\s*>>\s*2/.test(src)
  || /lineaFiltrada\[i\]\s*-\s*\(lineaFiltrada\[i\] >> 2\)/.test(src);
check("QTR: filtro EWMA con camino rápido (no retrasa el borde)",
  ewmaOk && /LINE_FAST_MARGIN/.test(src));

// ---------------------------------------------------------------- diagnóstico serial (MCP)
for (const label of ["L30", "C0", "R30", "L90", "R90"]) {
  check(`diagnóstico: etiqueta [${label}]`, src.includes(`VL53L0X[${label}]`));
}
check("diagnóstico: PWM real por canal", /PWMA="/.test(src) && /dutyIzq/.test(src) && /dutyDer/.test(src));
check("diagnóstico: factorPWM reportado (PWMx=)", /PWMx=/.test(src));

// ---------------------------------------------------------------- reporte
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
}
console.log(`\n${results.length - failed}/${results.length} chequeos OK  ·  ${path}`);
process.exit(failed ? 1 : 0);
