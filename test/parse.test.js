/**
 * Pruebas del parser serial (lib/serial-parser.js).
 * Ejecutar: npm test   (node --test test/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSerialSample } from "../lib/serial-parser.js";

const toLines = (texts) => texts.map((data) => ({ timestamp: "2026-01-01T00:00:00.000Z", data }));

// Muestra tal como la emite el firmware Kraken v3.2 FINAL cada 300 ms
const KRAKEN_SAMPLE = [
  "VL53L0X[L30]: distance=120mm",
  "VL53L0X[C0]: distance=85mm",
  "VL53L0X[R30]: distance=130mm",
  "VL53L0X[L90]: distance=340mm",
  "VL53L0X[R90]: distance=410mm",
  "QTR: 690",
  "QTR: 705",
  "TB6612: STBY=1 PWMA=219 PWMB=219 CMD_A=86 CMD_B=86 PWMx=1.00",
  "VBAT: 7.41V",
  "[DIST] L30=120 C0=85 R30=130 L90=340 R90=410 mm | A0r=688 A1r=701 | Vbat=7.41 V  PWMx=1.00",
];

test("formato Kraken v3.2 FINAL: captura los 5 láseres con etiqueta", () => {
  const d = parseSerialSample(toLines(KRAKEN_SAMPLE));
  const all = d.sensors.vl53l0xAll;

  assert.equal(Object.keys(all).length, 5);
  assert.deepEqual(
    Object.keys(all).sort(),
    ["C0", "L30", "L90", "R30", "R90"]
  );
  assert.equal(all.L30.distance_mm, 120);
  assert.equal(all.C0.distance_mm, 85);
  assert.equal(all.R30.distance_mm, 130);
  assert.equal(all.L90.distance_mm, 340);
  assert.equal(all.R90.distance_mm, 410);
});

test("vl53l0x conserva la primera lectura por compatibilidad", () => {
  const d = parseSerialSample(toLines(KRAKEN_SAMPLE));
  assert.equal(d.sensors.vl53l0x.label, "L30");
  assert.equal(d.sensors.vl53l0x.distance_mm, 120);
});

test("QTR-1A: toma la primera línea y respeta el valor", () => {
  const d = parseSerialSample(toLines(KRAKEN_SAMPLE));
  assert.equal(d.sensors.qtr1a.reflectance, 690);
});

test("TB6612: conserva el estado completo con PWM real y factorPWM", () => {
  const d = parseSerialSample(toLines(KRAKEN_SAMPLE));
  const status = d.sensors.tb6612fng.status;
  assert.match(status, /STBY=1/);
  assert.match(status, /PWMA=219/);
  assert.match(status, /PWMB=219/);
  assert.match(status, /PWMx=1.00/);
});

test("muestra completa del Kraken se reporta como saludable", () => {
  const d = parseSerialSample(toLines(KRAKEN_SAMPLE));
  assert.equal(d.healthy, true);
  assert.match(d.healthSummary, /VL53L0X ✓/);
  assert.match(d.healthSummary, /QTR-1A ✓/);
  assert.match(d.healthSummary, /TB6612FNG ✓/);
});

test("la línea compacta [DIST] y VBAT no se confunden con datos", () => {
  const d = parseSerialSample(toLines(KRAKEN_SAMPLE));
  // Si la línea [DIST] se parseara, aparecerían etiquetas duplicadas/basura
  assert.equal(Object.keys(d.sensors.vl53l0xAll).length, 5);
  assert.ok(!("mm" in d.sensors.vl53l0xAll));
  assert.ok(!("A0r" in d.sensors.vl53l0xAll));
});

test("formatos antiguos y alternativos siguen parseando", () => {
  const d = parseSerialSample(toLines([
    "VL53L0X: distance=456mm", // formato documentado original
    "QTR: 300",
    "REFLECT: 512",
    "TB6612: STBY=1 PWMA=200 PWMB=150",
  ]));
  assert.equal(d.sensors.vl53l0x.label, "sin_etiqueta");
  assert.equal(d.sensors.vl53l0x.distance_mm, 456);
  assert.equal(d.sensors.qtr1a.reflectance, 300); // gana el primero
  assert.match(d.sensors.tb6612fng.status, /PWMB=150/);
});

test("formatos compactos VL53L0X: Nmm y DIST:N", () => {
  const a = parseSerialSample(toLines(["VL53L0X: 789mm"]));
  assert.equal(a.sensors.vl53l0x.distance_mm, 789);

  const b = parseSerialSample(toLines(["DIST:321"]));
  assert.equal(b.sensors.vl53l0x.distance_mm, 321);
});

test("sensor caído (ERR) no genera datos falsos", () => {
  const d = parseSerialSample(toLines([
    "VL53L0X[L30]: distance=ERR",
    "VL53L0X[C0]: distance=90mm",
  ]));
  assert.ok(!("L30" in d.sensors.vl53l0xAll));
  assert.equal(d.sensors.vl53l0xAll.C0.distance_mm, 90);
  assert.equal(d.sensors.vl53l0x.label, "C0");
});

test("sin datos: no saludable y marcado con ✗", () => {
  const d = parseSerialSample(toLines(["hola", "mundo"]));
  assert.equal(d.healthy, false);
  assert.match(d.healthSummary, /VL53L0X ✗/);
  assert.match(d.healthSummary, /QTR-1A ✗/);
  assert.match(d.healthSummary, /TB6612FNG ✗/);
});

test("muestra vacía no explota", () => {
  const d = parseSerialSample(toLines([]));
  assert.equal(d.totalLines, 0);
  assert.deepEqual(d.sensors.vl53l0xAll, {});
  assert.deepEqual(d.rawSample, []);
  assert.equal(d.healthy, false);
});

test("rawSample recorta a 20 líneas y totalLines cuenta todo", () => {
  const many = Array.from({ length: 35 }, (_, i) => `linea ${i}`);
  const d = parseSerialSample(toLines(many));
  assert.equal(d.totalLines, 35);
  assert.equal(d.rawSample.length, 20);
  assert.equal(d.rawSample[0].data, "linea 0");
  assert.equal(d.rawSample[19].data, "linea 19");
});
