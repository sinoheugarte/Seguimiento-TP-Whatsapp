# Seguimiento TP — WhatsApp + Email

Aplicacion para enviar mensajes automatizados a grupos de WhatsApp y correos de Outlook 365, con soporte para adjuntar fotos.

## Requisitos

- Node.js 18 o superior
- Cuenta de WhatsApp en el celular de empresa
- Correo de Microsoft 365 con SMTP habilitado

## Instalacion

```bash
npm install
cp .env.example .env
# Edita .env con tus credenciales
```

## Configuracion

### 1. Credenciales (.env)

```env
EMAIL_USER=tu_correo@empresa.com
EMAIL_PASS=tu_contrasena_de_app
EMAIL_FROM="Empresa <tu_correo@empresa.com>"
PORT=3000
```

> Para Outlook 365: usa tu contrasena normal o una contrasena de aplicacion si tienes MFA activado.

### 2. Grupos y programaciones (config.json)

Edita `config.json` para:
- Agregar los **chatId** de tus grupos de WhatsApp
- Definir los **destinatarios de email**
- Configurar **programaciones automaticas** con expresiones cron

#### Como obtener el chatId de un grupo

1. Inicia la aplicacion (`npm start`)
2. Escanea el QR con tu celular
3. Abre `http://localhost:3000/api/estado`
4. Busca la lista `grupos` — ahi aparecen todos los grupos con su chatId
5. Copia el chatId al `config.json`

#### Expresiones cron de ejemplo

| Descripcion              | Expresion       |
|--------------------------|-----------------|
| Cada lunes a las 9am     | `0 9 * * 1`     |
| Lunes a viernes a las 8am| `0 8 * * 1-5`   |
| Todos los dias a las 6pm | `0 18 * * *`    |
| Cada hora                | `0 * * * *`     |

## Uso

```bash
npm start
```

1. Se mostrara un QR en la terminal — escanea con WhatsApp de tu celular
2. Abre el panel en `http://localhost:3000`
3. Usa las pestanas para enviar mensajes manualmente o gestionar programaciones

## Panel web

- **Envio Combinado**: envia el mismo mensaje a grupos de WhatsApp y correos al mismo tiempo
- **Solo WhatsApp**: selecciona grupo, escribe mensaje y adjunta foto
- **Solo Email**: ingresa destinatarios, asunto, cuerpo y adjunto
- **Programaciones**: ve las programaciones activas y ejecutalas manualmente

## Fotos

Coloca las fotos que quieres usar en la carpeta `media/` y referencia el nombre en `config.json`.
