/**
 * Parser heurístico de muestras seriales para run_hardware_diagnostics.
 * Función pura (sin I/O) para que sea testeable sin hardware.
 *
 * Formatos reconocidos (por línea):
 *   VL53L0X: "VL53L0X[L30]: distance=123mm", "VL53L0X: 456mm", "VL53L0X: 789mm" o "DIST:321"
 *            -> etiqueta opcional entre corchetes (L30/C0/R30/L90/R90 en el firmware Kraken)
 *   QTR-1A:  "QTR: 512" o "REFLECT: 512"   (gana la primera línea que matchee)
 *   TB6612:  "TB6612: STBY=1 PWMA=200 PWMB=150 CMD_A=50 CMD_B=30 PWMx=1.00"
 *
 * Las líneas de solo texto (ej. "[DIST] L30=... C0=..." o "VBAT: 7.4V") se ignoran.
 */

/**
 * @param {Array<{timestamp?: string, data: string}>} lines líneas capturadas del puerto serial
 * @returns {object} diagnostics con sensors, healthSummary, healthy, rawSample, totalLines
 */
export function parseSerialSample(lines) {
  const diagnostics = {
    totalLines: lines.length,
    sensors: {
      vl53l0x: null,    // primera lectura (compatibilidad)
      vl53l0xAll: {},   // todas las lecturas indexadas por etiqueta [L30/C0/...]
      qtr1a: null,      // reflectance 0-1023
      tb6612fng: null,  // motor status
    },
    rawSample: lines.slice(0, 20), // primeras 20 líneas para contexto
  };

  for (const { data } of lines) {
    // VL53L0X: etiqueta opcional + "distance=" opcional + número
    const vlMatch = data.match(/(?:VL53L0X|DIST)(?:\[([^\]]+)\])?[\s:=]*(?:distance\s*=\s*)?(\d+)/i);
    if (vlMatch) {
      const label = vlMatch[1] || "sin_etiqueta";
      const value = parseInt(vlMatch[2], 10);
      diagnostics.sensors.vl53l0xAll[label] = { distance_mm: value, raw: data };
      if (!diagnostics.sensors.vl53l0x) {
        diagnostics.sensors.vl53l0x = { label, distance_mm: value, raw: data };
      }
    }

    // QTR-1A
    const qtrMatch = data.match(/(?:QTR|REFLECT)[\s:=]+(\d+)/i);
    if (qtrMatch && !diagnostics.sensors.qtr1a) {
      diagnostics.sensors.qtr1a = { reflectance: parseInt(qtrMatch[1], 10), raw: data };
    }

    // TB6612FNG
    const motorMatch = data.match(/(?:TB6612)[\s:=]+(.+)/i);
    if (motorMatch && !diagnostics.sensors.tb6612fng) {
      diagnostics.sensors.tb6612fng = { status: motorMatch[1].trim(), raw: data };
    }
  }

  // Resumen de salud
  const health = [];
  if (diagnostics.sensors.vl53l0x) health.push("VL53L0X ✓");
  else health.push("VL53L0X ✗ (no data)");

  if (diagnostics.sensors.qtr1a) health.push("QTR-1A ✓");
  else health.push("QTR-1A ✗ (no data)");

  if (diagnostics.sensors.tb6612fng) health.push("TB6612FNG ✓");
  else health.push("TB6612FNG ✗ (no data)");

  diagnostics.healthSummary = health.join(" | ");
  diagnostics.healthy = Boolean(
    diagnostics.sensors.vl53l0x && diagnostics.sensors.qtr1a && diagnostics.sensors.tb6612fng
  );

  return diagnostics;
}
