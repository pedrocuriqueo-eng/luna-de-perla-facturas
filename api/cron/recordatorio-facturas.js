// api/cron/recordatorio-facturas.js
// Vercel Cron: lee facturas PENDIENTES, detecta vencidas y por vencer (3 días),
// arma un resumen y lo envía por WhatsApp (a un número fijo de prueba).

import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Número de prueba (fijo por ahora). Cuando salgas del Sandbox, esto cambia.
const NUMERO_DESTINO = process.env.NUMERO_RECORDATORIOS || '+56988147155';

// Días de anticipación para el aviso "por vencer".
const DIAS_ANTICIPACION = 3;

// Formatea montos como pesos chilenos: 200000 -> "$200.000"
function fmtMonto(n) {
  const num = Math.round(Number(n) || 0);
  return '$' + num.toLocaleString('es-CL');
}

// Formatea fecha date (YYYY-MM-DD) a DD/MM
function fmtFecha(fechaStr) {
  const [y, m, d] = fechaStr.split('-');
  return `${d}/${m}`;
}

export default async function handler(req, res) {
  // Proteger el endpoint.
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    // Fecha de hoy en zona horaria de Chile (para no desfasar por UTC).
    const hoyCL = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }); // formato YYYY-MM-DD
    const hoy = new Date(hoyCL + 'T00:00:00');

    const limite = new Date(hoy);
    limite.setDate(limite.getDate() + DIAS_ANTICIPACION);
    const limiteStr = limite.toISOString().slice(0, 10);

    // 1. Traer facturas pendientes.
    const { data: facturas, error } = await supabase
      .from('facturas')
      .select('numero, proveedor, monto, fecha_vencimiento, estado')
      .eq('estado', 'pendiente');

    if (error) throw error;

    if (!facturas || facturas.length === 0) {
      return res.status(200).json({ mensaje: 'No hay facturas pendientes', enviado: false });
    }

    // 2. Clasificar en vencidas y por vencer.
    const vencidas = [];
    const porVencer = [];

    for (const f of facturas) {
      if (!f.fecha_vencimiento) continue;
      if (f.fecha_vencimiento < hoyCL) {
        vencidas.push(f);
      } else if (f.fecha_vencimiento <= limiteStr) {
        porVencer.push(f);
      }
    }

    // Si no hay nada relevante hoy, no molestar.
    if (vencidas.length === 0 && porVencer.length === 0) {
      return res.status(200).json({ mensaje: 'Sin vencidas ni por vencer hoy', enviado: false });
    }

    // 3. Armar el mensaje.
    const fechaHoyTexto = `${hoyCL.slice(8, 10)}/${hoyCL.slice(5, 7)}`;
    let cuerpo = `*Luna de Perla - Facturas por pagar (${fechaHoyTexto})*\n`;

    if (vencidas.length > 0) {
      const totalV = vencidas.reduce((s, f) => s + Number(f.monto || 0), 0);
      cuerpo += `\n⚠️ *Vencidas:* ${vencidas.length} · ${fmtMonto(totalV)}\n`;
      for (const f of vencidas) {
        cuerpo += `• #${f.numero} ${f.proveedor} ${fmtMonto(f.monto)} (venció ${fmtFecha(f.fecha_vencimiento)})\n`;
      }
    }

    if (porVencer.length > 0) {
      const totalP = porVencer.reduce((s, f) => s + Number(f.monto || 0), 0);
      cuerpo += `\n⏰ *Por vencer (${DIAS_ANTICIPACION} días):* ${porVencer.length} · ${fmtMonto(totalP)}\n`;
      for (const f of porVencer) {
        cuerpo += `• #${f.numero} ${f.proveedor} ${fmtMonto(f.monto)} (vence ${fmtFecha(f.fecha_vencimiento)})\n`;
      }
    }

    // 4. Enviar por WhatsApp.
    const envio = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${NUMERO_DESTINO}`,
      body: cuerpo,
    });

    return res.status(200).json({
      enviado: true,
      sid: envio.sid,
      vencidas: vencidas.length,
      porVencer: porVencer.length,
    });
  } catch (err) {
    console.error('Error en recordatorio-facturas:', err);
    return res.status(500).json({ error: err.message });
  }
}
