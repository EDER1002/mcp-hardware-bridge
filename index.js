#!/usr/bin/env node
/**
 * Hardware Bridge & Monitor - MCP Server
 * Puente entre IA y hardware robótico (Arduino Nano, sensores VL53L0X/QTR-1A, driver TB6612FNG)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, execFile } from "child_process";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { listSerialPorts, identifyArduinoPorts, pickBestPort, formatPortInfo } from "./lib/port-discovery.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARDUINO_CLI = "/home/eder/.local/bin/arduino-cli";
const ARDUINO_FQBN = "arduino:avr:nano"; // Arduino Nano (ATmega328P)

// Puerto por defecto: auto-descubrimiento al arrancar (se resuelve lazy en las tools)
let DEFAULT_PORT_CACHE = null;
async function getDefaultPort() {
  if (DEFAULT_PORT_CACHE) return DEFAULT_PORT_CACHE;
  DEFAULT_PORT_CACHE = await pickBestPort();
  return DEFAULT_PORT_CACHE || "/dev/ttyUSB0";
}

// ============================================================
// Utilidades
// ============================================================

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `Exit code ${code}`));
    });
    child.on("error", reject);
  });
}

async function writeTempIno(sourceCode) {
  const tmpFile = join(tmpdir(), `sketch_${Date.now()}.ino`);
  await fs.writeFile(tmpFile, sourceCode, "utf8");
  return tmpFile;
}

// ============================================================
// Herramienta 1: arduino_compile_upload
// ============================================================

async function arduinoCompileUpload({ sourceCode, port, fqbn = ARDUINO_FQBN }) {
  const targetPort = port || await getDefaultPort();
  const inoPath = await writeTempIno(sourceCode);
  const buildDir = join(tmpdir(), `build_${Date.now()}`);

  try {
    // Compilar
    const compileResult = await runCommand(ARDUINO_CLI, [
      "compile",
      "--fqbn", fqbn,
      "--output-dir", buildDir,
      inoPath,
    ]);

    // Subir
    const uploadResult = await runCommand(ARDUINO_CLI, [
      "upload",
      "--fqbn", fqbn,
      "--port", targetPort,
      "--input-dir", buildDir,
    ]);

    // Limpiar temporales
    await fs.unlink(inoPath).catch(() => {});
    await fs.rm(buildDir, { recursive: true, force: true }).catch(() => {});

    return {
      success: true,
      port: targetPort,
      fqbn,
      compileOutput: compileResult.stdout,
      uploadOutput: uploadResult.stdout,
    };
  } catch (err) {
    await fs.unlink(inoPath).catch(() => {});
    await fs.rm(buildDir, { recursive: true, force: true }).catch(() => {});
    throw new McpError(ErrorCode.InternalError, `Arduino CLI error: ${err.message}\n${err.stderr || ""}`);
  }
}

// ============================================================
// Herramienta 2: serial_data_stream
// ============================================================

async function serialDataStream({ port, baudRate = 115200, durationMs = 5000 }) {
  const targetPort = port || await getDefaultPort();
  return new Promise((resolve, reject) => {
    const serialPort = new SerialPort({ path: targetPort, baudRate, autoOpen: false });
    const parser = serialPort.pipe(new ReadlineParser({ delimiter: "\n" }));

    const lines = [];
    let closed = false;

    const cleanup = () => {
      if (!closed) {
        closed = true;
        serialPort.close().catch(() => {});
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve({ port: targetPort, lines, truncated: lines.length > 0 });
    }, durationMs);

    parser.on("data", (line) => {
      lines.push({ timestamp: new Date().toISOString(), data: line.trim() });
    });

    serialPort.on("error", (err) => {
      clearTimeout(timeout);
      cleanup();
      reject(new McpError(ErrorCode.InternalError, `Serial error on ${targetPort}: ${err.message}`));
    });

    serialPort.open((err) => {
      if (err) {
        clearTimeout(timeout);
        reject(new McpError(ErrorCode.InternalError, `Cannot open ${targetPort}: ${err.message}`));
      }
    });
  });
}

// ============================================================
// Herramienta 3: run_hardware_diagnostics
// ============================================================

async function runHardwareDiagnostics({ port, baudRate = 115200, sampleMs = 3000 }) {
  const targetPort = port || await getDefaultPort();

  // 1. Leer muestra serial
  const { lines } = await serialDataStream({ port: targetPort, baudRate, durationMs: sampleMs });

  // 2. Parsear heurísticamente sensores conocidos
  const diagnostics = {
    timestamp: new Date().toISOString(),
    port: targetPort,
    baudRate,
    sampleDurationMs: sampleMs,
    totalLines: lines.length,
    sensors: {
      vl53l0x: null,    // distance mm
      qtr1a: null,      // reflectance 0-1023
      tb6612fng: null,  // motor status
    },
    rawSample: lines.slice(0, 20), // primeras 20 líneas para contexto
  };

  // Patrones esperados (ajustar según firmware real)
  for (const { data } of lines) {
    // VL53L0X: "VL53L0X: distance=123mm" o "DIST:123"
    const vlMatch = data.match(/(?:VL53L0X|DIST)[\s:=]+(\d+)/i);
    if (vlMatch && !diagnostics.sensors.vl53l0x) {
      diagnostics.sensors.vl53l0x = { distance_mm: parseInt(vlMatch[1], 10), raw: data };
    }

    // QTR-1A: "QTR:456" o "REFLECT:456"
    const qtrMatch = data.match(/(?:QTR|REFLECT)[\s:=]+(\d+)/i);
    if (qtrMatch && !diagnostics.sensors.qtr1a) {
      diagnostics.sensors.qtr1a = { reflectance: parseInt(qtrMatch[1], 10), raw: data };
    }

    // TB6612FNG: "TB6612: STBY=1 PWMA=200 PWMB=150"
    const motorMatch = data.match(/(?:TB6612)[\s:=]+(.+)/i);
    if (motorMatch && !diagnostics.sensors.tb6612fng) {
      diagnostics.sensors.tb6612fng = { status: motorMatch[1].trim(), raw: data };
    }
  }

  // 3. Resumen de salud
  const health = [];
  if (diagnostics.sensors.vl53l0x) health.push("VL53L0X ✓");
  else health.push("VL53L0X ✗ (no data)");

  if (diagnostics.sensors.qtr1a) health.push("QTR-1A ✓");
  else health.push("QTR-1A ✗ (no data)");

  if (diagnostics.sensors.tb6612fng) health.push("TB6612FNG ✓");
  else health.push("TB6612FNG ✗ (no data)");

  diagnostics.healthSummary = health.join(" | ");
  diagnostics.healthy = diagnostics.sensors.vl53l0x && diagnostics.sensors.qtr1a && diagnostics.sensors.tb6612fng;

  return diagnostics;
}

// ============================================================
// Herramienta 4: list_serial_ports (nueva)
// ============================================================

async function listSerialPortsTool({ detailed = false }) {
  const rawPorts = await listSerialPorts();
  const arduinos = await identifyArduinoPorts();
  const best = await pickBestPort();

  const result = {
    allPorts: rawPorts,
    arduinoPorts: arduinos.map(a => ({
      port: a.port,
      name: a.name,
      vid: a.vid,
      pid: a.pid,
    })),
    recommended: best,
    recommendedInfo: best ? formatPortInfo(arduinos.find(a => a.port === best) || best) : "none",
  };

  if (detailed) {
    result.details = arduinos;
  }
  return result;
}

// ============================================================
// Definición de herramientas MCP
// ============================================================

const TOOLS = [
  {
    name: "arduino_compile_upload",
    description: "Compila y sube código C++ a un Arduino Nano vía arduino-cli. Usa auto-descubrimiento de puerto si no se especifica.",
    inputSchema: {
      type: "object",
      properties: {
        sourceCode: { type: "string", description: "Código fuente .ino (C++) completo" },
        port: { type: "string", description: "Puerto serial (ej. /dev/ttyUSB0). Omitir para auto-descubrir." },
        fqbn: { type: "string", description: "Fully Qualified Board Name", default: ARDUINO_FQBN },
      },
      required: ["sourceCode"],
    },
  },
  {
    name: "serial_data_stream",
    description: "Abre el puerto serial, captura datos durante N ms y devuelve array de líneas con timestamp. Usa auto-descubrimiento de puerto si no se especifica.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "string", description: "Puerto serial. Omitir para auto-descubrir." },
        baudRate: { type: "number", default: 115200 },
        durationMs: { type: "number", description: "Duración de captura en ms", default: 5000 },
      },
    },
  },
  {
    name: "run_hardware_diagnostics",
    description: "Ejecuta diagnóstico de hardware: lee puerto serial y parsea sensores VL53L0X, QTR-1A, TB6612FNG. Usa auto-descubrimiento de puerto si no se especifica.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "string", description: "Puerto serial. Omitir para auto-descubrir." },
        baudRate: { type: "number", default: 115200 },
        sampleMs: { type: "number", description: "Muestreo en ms", default: 3000 },
      },
    },
  },
  {
    name: "list_serial_ports",
    description: "Descubre y lista puertos seriales disponibles, identifica Arduinos por USB vid:pid y recomienda el mejor puerto.",
    inputSchema: {
      type: "object",
      properties: {
        detailed: { type: "boolean", description: "Incluir salida cruda de udevadm", default: false },
      },
    },
  },
];

// ============================================================
// Servidor MCP
// ============================================================

const server = new Server(
  { name: "hardware-bridge-monitor", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "arduino_compile_upload":
        return { content: [{ type: "text", text: JSON.stringify(await arduinoCompileUpload(args), null, 2) }] };
      case "serial_data_stream":
        return { content: [{ type: "text", text: JSON.stringify(await serialDataStream(args), null, 2) }] };
      case "run_hardware_diagnostics":
        return { content: [{ type: "text", text: JSON.stringify(await runHardwareDiagnostics(args), null, 2) }] };
      case "list_serial_ports":
        return { content: [{ type: "text", text: JSON.stringify(await listSerialPortsTool(args), null, 2) }] };
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, err.message);
  }
});

// ============================================================
// Arranque
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("✅ Hardware Bridge & Monitor MCP server running on stdio");
  console.error("   Tools: arduino_compile_upload, serial_data_stream, run_hardware_diagnostics, list_serial_ports");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});