// api/cron/enviar-whatsapp.js
// Vercel Cron: revisa mensajes programados pendientes en Supabase
// y los envía por Twilio WhatsApp cuando su hora ya llegó.

import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role: ignora RLS, corre server-side
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export default async function handler(req, res) {
  // 1. Proteger el endpoint: solo Vercel Cron (con el CRON_SECRET) puede dispararlo.
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const ahora = new Date().toISOString();

    // 2. Traer mensajes pendientes cuya hora programada ya pasó.
    const { data: mensajes, error } = await supabase
      .from('mensajes_programados')
      .select('*')
      .eq('estado', 'pendiente')
      .lte('enviar_en', ahora)
      .limit(50);

    if (error) throw error;

    if (!mensajes || mensajes.length === 0) {
      return res.status(200).json({ enviados: 0, mensaje: 'Nada pendiente' });
    }

    const resultados = [];

    // 3. Enviar cada mensaje.
    for (const msg of mensajes) {
      try {
        const envio = await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM, // ej: 'whatsapp:+14155238886' (Sandbox)
          to: `whatsapp:${msg.telefono}`,
          contentSid: msg.content_sid || undefined,
          contentVariables: msg.content_variables || undefined,
          body: msg.content_sid ? undefined : msg.cuerpo,
        });

        // 4. Marcar como enviado.
        await supabase
          .from('mensajes_programados')
          .update({
            estado: 'enviado',
            twilio_sid: envio.sid,
            enviado_en: new Date().toISOString(),
          })
          .eq('id', msg.id);

        resultados.push({ id: msg.id, sid: envio.sid, ok: true });
      } catch (errEnvio) {
        // 5. Registrar el fallo sin frenar el resto del lote.
        await supabase
          .from('mensajes_programados')
          .update({
            estado: 'error',
            error_detalle: String(errEnvio.message).slice(0, 500),
          })
          .eq('id', msg.id);

        resultados.push({ id: msg.id, ok: false, error: errEnvio.message });
      }
    }

    const enviados = resultados.filter((r) => r.ok).length;
    return res.status(200).json({ enviados, total: mensajes.length, resultados });
  } catch (err) {
    console.error('Error en cron:', err);
    return res.status(500).json({ error: err.message });
  }
}
