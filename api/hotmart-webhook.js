// api/hotmart-webhook.js
// Recibe webhooks de Hotmart, crea usuario en Supabase y envía credenciales por email.

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

// Eventos de Hotmart que indican una compra exitosa
const PURCHASE_EVENTS = [
  'PURCHASE_APPROVED',
  'PURCHASE_COMPLETE',
  'SUBSCRIPTION_REACTIVATED',
];

function generatePassword() {
  // 12 chars sin caracteres confusos (sin 0/O, 1/l/I)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verificar el token secreto de Hotmart (configurar en el dashboard de Hotmart)
  const hottok = req.headers['x-hotmart-hottok'];
  if (process.env.HOTMART_HOTTOK && hottok !== process.env.HOTMART_HOTTOK) {
    console.error('[hotmart] Hottok inválido:', hottok);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Vercel parsea el body JSON automáticamente
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { event, data } = payload || {};

    console.log('[hotmart] Evento recibido:', event);

    // Ignorar eventos que no sean compras
    if (!PURCHASE_EVENTS.includes(event)) {
      return res.status(200).json({ received: true, skipped: true, event });
    }

    const email = data?.buyer?.email?.toLowerCase().trim();
    const name = data?.buyer?.name || data?.buyer?.first_name || 'Comprador';
    const transaction = data?.purchase?.transaction || '';

    if (!email) {
      console.error('[hotmart] Sin email en payload:', JSON.stringify(payload));
      return res.status(400).json({ error: 'No buyer email in payload' });
    }

    console.log(`[hotmart] Procesando compra: ${email} (${transaction})`);

    // Generar contraseña temporal
    const tempPassword = generatePassword();

    // Crear usuario en Supabase con email ya verificado
    const { data: createdUser, error: createError } = await supabase.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true, // no requiere que el usuario confirme su email
      user_metadata: {
        full_name: name,
        source: 'hotmart',
        hotmart_transaction: transaction,
      },
    });

    if (createError) {
      // Si el usuario ya existe, retornar 200 sin error
      if (
        createError.message?.includes('already been registered') ||
        createError.message?.includes('already exists') ||
        createError.status === 422
      ) {
        console.log(`[hotmart] Usuario ${email} ya existe, saltando creación`);
        return res.status(200).json({ received: true, existing: true });
      }
      throw createError;
    }

    // Enviar email de bienvenida con credenciales
    const { error: emailError } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'noreply@resend.dev',
      to: email,
      subject: '¡Tu acceso está listo! 🌸',
      html: buildWelcomeEmail(name, email, tempPassword),
    });

    if (emailError) {
      // No fallar el webhook si el email falla — el usuario ya fue creado
      console.error('[hotmart] Error enviando email:', emailError);
    }

    console.log(`[hotmart] Usuario creado exitosamente: ${email} (${createdUser.user?.id})`);
    return res.status(200).json({
      received: true,
      created: true,
      userId: createdUser.user?.id,
    });

  } catch (err) {
    // Siempre retornar 200 a Hotmart para evitar reintentos innecesarios
    console.error('[hotmart] Error inesperado:', err);
    return res.status(200).json({ received: true, error: err.message });
  }
};

function buildWelcomeEmail(name, email, password) {
  const firstName = name.split(' ')[0];
  const appUrl = 'https://apps-rouge-delta.vercel.app';

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FDFAFC;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:520px;margin:40px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 2px 20px rgba(0,0,0,0.08)">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#E8537A,#C9406A);padding:36px 40px;text-align:center">
      <h1 style="margin:0;color:white;font-size:26px;font-weight:700;letter-spacing:-0.5px">
        ¡Bienvenida, ${firstName}! 🌸
      </h1>
      <p style="margin:10px 0 0;color:rgba(255,255,255,0.85);font-size:15px">
        Tu suscripción fue activada con éxito
      </p>
    </div>

    <!-- Body -->
    <div style="padding:36px 40px">
      <p style="color:#444;font-size:15px;line-height:1.6;margin-top:0">
        Aquí están tus credenciales para acceder a la app:
      </p>

      <!-- Credentials box -->
      <div style="background:#FFF5F8;border:1.5px solid #F8D0DC;border-radius:12px;padding:22px 26px;margin:20px 0">
        <div style="margin-bottom:16px">
          <div style="font-size:11px;font-weight:600;color:#E8537A;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px">
            Email
          </div>
          <div style="font-size:15px;font-weight:500;color:#1A1218">${email}</div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;color:#E8537A;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px">
            Contraseña temporal
          </div>
          <div style="font-size:20px;font-weight:700;color:#1A1218;font-family:'Courier New',monospace;letter-spacing:2px">
            ${password}
          </div>
        </div>
      </div>

      <!-- CTA -->
      <div style="text-align:center;margin:30px 0">
        <a href="${appUrl}"
           style="display:inline-block;background:#E8537A;color:white;text-decoration:none;padding:15px 36px;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:0.3px">
          Entrar a la app →
        </a>
      </div>

      <!-- Footer note -->
      <p style="color:#999;font-size:13px;line-height:1.6;border-top:1px solid #F0ECF0;padding-top:20px;margin-bottom:0">
        Por seguridad, te recomendamos cambiar tu contraseña después de tu primer inicio de sesión.<br><br>
        ¿Tienes dudas? Responde a este correo y te ayudamos.
      </p>
    </div>
  </div>
</body>
</html>`;
}
