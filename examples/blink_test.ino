// Sketch de prueba para validar arduino_compile_upload
// Hardware: Arduino Nano + LED builtin (D13)

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  while (!Serial) {}
  Serial.println("READY: Blink test started");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("LED:ON");
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("LED:OFF");
  delay(500);
}