# Hardware Bridge & Monitor — MCP Server

Puente **Model Context Protocol (MCP)** entre una IA (Claude, Cursor, OpenCode, etc.) y hardware robótico real: **Arduino Nano** + sensores **VL53L0X** (distancia), **QTR-1A** (reflectancia) y driver **TB6612FNG** (motores DC).

Expone 4 herramientas MCP listas para usar desde el chat de la IA.

---

## 🚀 Instalación rápida

```bash
git clone https://github.com/EDER1002/mcp-hardware-bridge.git
cd "mcp-hardware-bridge"   # o "Hardware Bridge & Monitor" si clonas con el nombre original
npm install
npm run build   # opcional, solo si usas TypeScript; este proyecto es ESM puro
```

> **Requisitos:** Node ≥ 20, `arduino-cli` en PATH (`~/.local/bin/arduino-cli`), core `arduino:avr` instalado.

---

## ⚙️ Configuración del cliente MCP

Agrega esto a tu archivo de configuración MCP:

| Cliente | Archivo |
|---------|---------|
| **Claude Desktop** (Linux) | `~/.config/claude-desktop/claude_desktop_config.json` |
| **Claude Desktop** (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **OpenCode** | `~/.config/opencode/mcp.json` |
| **Cursor** | `~/.cursor/mcp.json` |

```json
{
  "mcpServers": {
    "hardware-bridge": {
      "command": "node",
      "args": ["/home/eder/Hardware Bridge & Monitor/index.js"]
    }
  }
}
```

Reinicia el cliente. Verás 4 tools disponibles.

---

## 🛠 Herramientas expuestas

| Tool | Qué hace | Parámetros clave |
|------|----------|------------------|
| `list_serial_ports` | Descubre puertos `/dev/ttyUSB*`, `/dev/ttyACM*`, identifica Arduinos por **USB vid:pid** (FTDI `0403:6001`, CH340 `1a86:7523`, CP210x `10c4:ea60`, etc.) y recomienda el mejor. | `detailed?: boolean` |
| `arduino_compile_upload` | Compila y sube un sketch `.ino` (C++) al Nano vía `arduino-cli`. **Puerto opcional** → usa auto-descubrimiento. | `sourceCode: string`, `port?: string`, `fqbn?: string` |
| `serial_data_stream` | Abre el puerto serial, captura N ms y devuelve líneas con timestamp. **Puerto opcional**. | `port?: string`, `baudRate?: number (default 115200)`, `durationMs?: number (default 5000)` |
| `run_hardware_diagnostics` | Lee una muestra serial y parsea sensores conocidos (VL53L0X, QTR-1A, TB6612FNG). Devuelve health summary + lecturas. **Puerto opcional**. | `port?: string`, `baudRate?: number`, `sampleMs?: number (default 3000)` |

---

## 🔌 Hardware soportado

| Componente | Conexión | Formato de salida esperado |
|------------|----------|----------------------------|
| **VL53L0X** (ToF distance) | I2C 0x29 (SDA/SCL) | `VL53L0X: distance=123mm` |
| **QTR-1A** (reflectancia) | Analógico A0 | `QTR: 456` |
| **TB6612FNG** (2× DC motors) | PWM D5/D6, DIR D7/D8/D9/D10, STBY D4 | `TB6612: STBY=1 PWMA=128 PWMB=77` |

> El firmware de referencia en `examples/firmware_diagnostic.ino` emite **exactamente** estos formatos.

---

## 📦 Firmware de ejemplo

```bash
# 1. Sube el firmware de diagnóstico (usa auto-descubrimiento de puerto)
#    Desde tu cliente MCP llama a:
#    arduino_compile_upload { "sourceCode": "<contenido de examples/firmware_diagnostic.ino>" }

# 2. Abre monitor serial para ver datos en bruto
#    serial_data_stream { "durationMs": 10000 }

# 3. Ejecuta diagnóstico automático
#    run_hardware_diagnostics { "sampleMs": 5000 }
```

### Comandos seriales interactivos (con firmware_diagnostic.ino)
| Tecla | Acción |
|-------|--------|
| `s` | Toggle STBY (standby) |
| `f` | Forward ambos motores 200/200 |
| `b` | Backward ambos motores 200/200 |
| `x` | Stop (PWM 0) |

---

## 🧰 Librerías Arduino necesarias

En Arduino IDE → **Library Manager**:
- `VL53L0X` (by Pololu)
- `Wire` (built-in)

Core: **Arduino AVR Boards** (`arduino:avr`) → incluye Nano (ATmega328P).

---

## 📁 Estructura del proyecto

```
Hardware Bridge & Monitor/
├── index.js                    # Servidor MCP (stdio) - 4 tools
├── package.json                # deps: @modelcontextprotocol/sdk, serialport
├── lib/
│   └── port-discovery.js       # Auto-descubrimiento puertos (ls + udevadm vid:pid)
├── examples/
│   ├── blink_test.ino          # Test básico LED + serial
│   └── firmware_diagnostic.ino # Firmware completo sensores + driver TB6612FNG
└── README.md
```

---

## 🔧 Desarrollo

```bash
# Modo watch (reinicia en cambios)
npm run dev

# Pruebas del parser serial (sin hardware, node:test)
npm test
```

### Verificación estática de un firmware (.ino)

Comprueba sin placa el mapa de pines (Tabla 4 del informe Kraken) e invariantes de seguridad
(motores apagados al encender, cuenta de 5 s, escape con prioridad, watchdog, EWMA, etc.):

```bash
node scripts/verify-firmware.mjs /ruta/a/Kraken_v3_2_FINAL.ino
```

Salida: un `PASS`/`FAIL` por chequeo; `exit 1` si alguno falla. No sustituye una prueba física.

---

## 🐛 Troubleshooting

| Problema | Solución |
|----------|----------|
| `Cannot open /dev/ttyUSB0` | Verifica permisos: `sudo usermod -a -G dialout $USER` y reloguea. O usa `udev` rule. |
| `arduino-cli not found` | Instala: `curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \| sh` y añade `~/.local/bin` al PATH. |
| `Error: spawn arduino-cli ENOENT` | El server usa `/home/eder/.local/bin/arduino-cli` hardcodeado. Cambia `ARDUINO_CLI` en `index.js` si está en otro sitio. |
| No detecta puerto | Conecta el Nano, ejecuta `list_serial_ports { "detailed": true }` para ver qué detecta `udevadm`. |
| Compilación falla | Asegúrate de tener el core `arduino:avr`: `arduino-cli core install arduino:avr`. |

---

## 📄 Licencia

MIT — úsalo, modifícalo, compártelo.

---

## 🤝 Contribuir

1. Fork
2. Rama `feature/algo-genial`
3. Commit convencional (`feat:`, `fix:`, `docs:`)
4. PR

---

**Hecho para robótica real + IA.** 🤖🔧