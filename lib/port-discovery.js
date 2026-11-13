/**
 * Auto-descubrimiento de puertos seriales Arduino
 * Uso: import { findArduinoPorts, pickBestPort } from './lib/port-discovery.js';
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Lista todos los puertos seriales candidatos (/dev/ttyUSB*, /dev/ttyACM*, /dev/ttyS*)
 */
export async function listSerialPorts() {
  const candidates = [];
  try {
    const { stdout } = await execFileAsync("ls", ["/dev/ttyUSB*", "/dev/ttyACM*", "/dev/ttyS*"], { shell: true });
    for (const line of stdout.trim().split("\n")) {
      const port = line.trim();
      if (port) candidates.push(port);
    }
  } catch {
    // ls falla si no hay matches; ignorar
  }
  return candidates;
}

/**
 * Intenta identificar puertos Arduino leyendo su USB vid:pid
 * Requiere `udevadm` o `lsusb -t`
 */
export async function identifyArduinoPorts() {
  const ports = await listSerialPorts();
  const arduinoPorts = [];

  for (const port of ports) {
    try {
      // udevadm info -a -n /dev/ttyUSB0 | grep -E 'idVendor|idProduct'
      const { stdout } = await execFileAsync("udevadm", ["info", "-a", "-n", port], { timeout: 2000 });
      const text = stdout.toLowerCase();

      // Arduino vid:pids comunes
      const known = [
        { vid: "2341", pid: "0043", name: "Arduino Uno/Nano (FT232R)" },
        { vid: "2341", pid: "803a", name: "Arduino Nano 33 IoT" },
        { vid: "2341", pid: "0057", name: "Arduino Nano Every" },
        { vid: "2a03", pid: "0043", name: "Arduino.org Nano" },
        { vid: "1a86", pid: "7523", name: "CH340/CH341 (clones Nano)" },
        { vid: "10c4", pid: "ea60", name: "CP210x (clones Nano)" },
        { vid: "0403", pid: "6001", name: "FTDI FT232R (originales)" },
      ];

      for (const { vid, pid, name } of known) {
        if (text.includes(`idvendor==="${vid}"`) && text.includes(`idproduct==="${pid}"`)) {
          arduinoPorts.push({ port, vid, pid, name, raw: text });
          break;
        }
      }
    } catch {
      // udevadm no disponible o error; seguimos
    }
  }
  return arduinoPorts;
}

/**
 * Selecciona el "mejor" puerto: prioriza Arduino identificado, luego primer ttyUSB/ACM
 */
export async function pickBestPort() {
  const arduinos = await identifyArduinoPorts();
  if (arduinos.length > 0) return arduinos[0].port;

  const all = await listSerialPorts();
  if (all.length > 0) return all[0];

  return null; // ninguno encontrado
}

/**
 * Formato legible para logging
 */
export function formatPortInfo(p) {
  if (!p) return "❌ Ningún puerto detectado";
  if (p.name) return `✅ ${p.port} — ${p.name} (${p.vid}:${p.pid})`;
  return `⚠️  ${p} — (desconocido)`;
}

// CLI rápido si se ejecuta directo
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    console.log("🔍 Buscando puertos seriales...\n");
    const ports = await listSerialPorts();
    console.log("Puertos crudos:", ports.length ? ports.join(", ") : "(ninguno)");

    const arduinos = await identifyArduinoPorts();
    console.log("\nArduinos detectados:");
    for (const a of arduinos) console.log("  " + formatPortInfo(a));

    const best = await pickBestPort();
    console.log("\nRecomendado:", formatPortInfo(best));
  })();
}