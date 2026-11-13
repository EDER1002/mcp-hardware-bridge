// ============================================================
// firmware_diagnostic.ino
// Firmware de diagnóstico para Arduino Nano + sensores robóticos
// Emite formatos que run_hardware_diagnostcs sabe parsear
//
// Hardware esperado:
//  - VL53L0X  (I2C 0x29)  -> distance mm
//  - QTR-1A   (analog A0) -> reflectance 0-1023
//  - TB6612FNG (PWM D5/D6, DIR D7/D8, STBY D4)
// ============================================================

#include <Wire.h>
#include <VL53L0X.h>

// ===== PINOUT (ajusta a tu cableado) =====
const uint8_t PIN_QTR       = A0;   // QTR-1A salida analógica
const uint8_t PIN_TB_STBY   = 4;    // TB6612FNG STBY
const uint8_t PIN_TB_PWMA   = 5;    // PWM motor A (timer0)
const uint8_t PIN_TB_PWMB   = 6;    // PWM motor B (timer0)
const uint8_t PIN_TB_AIN1   = 7;    // DIR motor A
const uint8_t PIN_TB_AIN2   = 8;    // DIR motor A
const uint8_t PIN_TB_BIN1   = 9;    // DIR motor B
const uint8_t PIN_TB_BIN2   = 10;   // DIR motor B

// ===== VL53L0X =====
VL53L0X vl53;

// ===== Estado =====
uint32_t lastPrint = 0;
const uint32_t PRINT_INTERVAL_MS = 200;  // 5 Hz
bool motorsEnabled = false;

void setup() {
  Serial.begin(115200);
  while (!Serial) {}
  Wire.begin();
  Wire.setClock(400000);  // 400 kHz I2C

  // ---- VL53L0X ----
  vl53.setTimeout(500);
  if (!vl53.init()) {
    Serial.println("VL53L0X: ERROR init");
  } else {
    vl53.setSignalRateLimit(0.1);
    vl53.setVcselPulsePeriod(VL53L0X::VcselPeriodPreRange, 18);
    vl53.setVcselPulsePeriod(VL53L0X::VcselPeriodFinalRange, 14);
    vl53.startContinuous(50);  // 50 ms inter-measurement
    Serial.println("VL53L0X: OK continuous 50ms");
  }

  // ---- QTR-1A ----
  pinMode(PIN_QTR, INPUT);
  Serial.println("QTR-1A: OK on A0");

  // ---- TB6612FNG ----
  pinMode(PIN_TB_STBY, OUTPUT);
  pinMode(PIN_TB_PWMA, OUTPUT);
  pinMode(PIN_TB_PWMB, OUTPUT);
  pinMode(PIN_TB_AIN1, OUTPUT);
  pinMode(PIN_TB_AIN2, OUTPUT);
  pinMode(PIN_TB_BIN1, OUTPUT);
  pinMode(PIN_TB_BIN2, OUTPUT);
  digitalWrite(PIN_TB_STBY, LOW);  // standby al arranque
  analogWrite(PIN_TB_PWMA, 0);
  analogWrite(PIN_TB_PWMB, 0);
  Serial.println("TB6612FNG: OK standby");

  Serial.println("READY: Diagnostic firmware running");
}

void loop() {
  uint32_t now = millis();

  // ----- Lectura sensores -----
  int16_t dist_mm = -1;
  if (vl53.readRangeContinuousMillimeters() != 0) {
    dist_mm = vl53.readRangeContinuousMillimeters();
  }

  uint16_t qtr_val = analogRead(PIN_QTR);  // 0-1023

  // Demo: pulso motores cada 3 s (para ver cambios en TB6612)
  static uint32_t motorDemo = 0;
  if (now - motorDemo > 3000) {
    motorDemo = now;
    motorsEnabled = !motorsEnabled;
    digitalWrite(PIN_TB_STBY, motorsEnabled ? HIGH : LOW);
    if (motorsEnabled) {
      // Motor A forward 50%, Motor B reverse 30%
      digitalWrite(PIN_TB_AIN1, HIGH);
      digitalWrite(PIN_TB_AIN2, LOW);
      digitalWrite(PIN_TB_BIN1, LOW);
      digitalWrite(PIN_TB_BIN2, HIGH);
      analogWrite(PIN_TB_PWMA, 128);  // 50%
      analogWrite(PIN_TB_PWMB, 77);   // 30%
    } else {
      analogWrite(PIN_TB_PWMA, 0);
      analogWrite(PIN_TB_PWMB, 0);
    }
  }

  // ----- Salida formateada para parser MCP -----
  if (now - lastPrint >= PRINT_INTERVAL_MS) {
    lastPrint = now;

    // VL53L0X
    if (dist_mm > 0 && dist_mm < 2000) {
      Serial.print("VL53L0X: distance=");
      Serial.print(dist_mm);
      Serial.println("mm");
    } else {
      Serial.println("VL53L0X: distance=OUT_OF_RANGE");
    }

    // QTR-1A
    Serial.print("QTR: ");
    Serial.println(qtr_val);

    // TB6612FNG
    Serial.print("TB6612: STBY=");
    Serial.print(digitalRead(PIN_TB_STBY) ? "1" : "0");
    Serial.print(" PWMA=");
    Serial.print((analogRead(PIN_TB_PWMA) * 255) / 1023);  // aprox
    Serial.print(" PWMB=");
    Serial.println((analogRead(PIN_TB_PWMB) * 255) / 1023);
  }

  // Comandos seriales simples para control manual
  if (Serial.available()) {
    char c = Serial.read();
    switch (c) {
      case 's':  // standby toggle
        motorsEnabled = !motorsEnabled;
        digitalWrite(PIN_TB_STBY, motorsEnabled);
        Serial.print("TB6612: STBY=");
        Serial.println(motorsEnabled ? "1" : "0");
        break;
      case 'f':  // forward
        digitalWrite(PIN_TB_AIN1, HIGH); digitalWrite(PIN_TB_AIN2, LOW);
        digitalWrite(PIN_TB_BIN1, HIGH); digitalWrite(PIN_TB_BIN2, LOW);
        analogWrite(PIN_TB_PWMA, 200); analogWrite(PIN_TB_PWMB, 200);
        Serial.println("TB6612: FWD 200/200");
        break;
      case 'b':  // backward
        digitalWrite(PIN_TB_AIN1, LOW); digitalWrite(PIN_TB_AIN2, HIGH);
        digitalWrite(PIN_TB_BIN1, LOW); digitalWrite(PIN_TB_BIN2, HIGH);
        analogWrite(PIN_TB_PWMA, 200); analogWrite(PIN_TB_PWMB, 200);
        Serial.println("TB6612: REV 200/200");
        break;
      case 'x':  // stop
        analogWrite(PIN_TB_PWMA, 0); analogWrite(PIN_TB_PWMB, 0);
        Serial.println("TB6612: STOP");
        break;
    }
  }
}