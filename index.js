const { makeWASocket, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const NodeCache = require('node-cache');
const qrcode = require('qrcode-terminal');
const util = require('util');
const { addDays, setHours, setMinutes, setDate } = require('date-fns');
const { zonedTimeToUtc, utcToZonedTime, format } = require('date-fns-tz');

let qrCode = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const timeZone = 'Asia/Jakarta'; // Zona waktu WIB

function logToFile(data) {
  const log_file = fs.createWriteStream(__dirname + '/debug.log', {flags : 'a'});
  log_file.write(util.format(data) + '\n');
}

function decodeMessage(message) {
  if (typeof message === 'string') {
    return Buffer.from(message, 'utf-8').toString();
  }
  return message;
}

async function connectWhatsapp() {
  try {
    console.log('Memulai koneksi WhatsApp...');
    logToFile('Memulai koneksi WhatsApp...');
    const auth = await useMultiFileAuthState("sessionDir");
    const msgRetryCounterCache = new NodeCache()

    const socket = makeWASocket({
      printQRInTerminal: false,
      browser: ["DAPABOT", "", ""],
      auth: auth.state,
      logger: pino({ level: "silent" }),
      msgRetryCounterMap: msgRetryCounterCache,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 5000,
      patchMessageBeforeSending: (message) => {
        const requiresPatch = !!(
          message.buttonsMessage ||
          message.templateMessage ||
          message.listMessage
        );
        if (requiresPatch) {
          message = {
            viewOnceMessage: {
              message: {
                messageContextInfo: {
                  deviceListMetadataVersion: 2,
                  deviceListMetadata: {},
                },
                ...message,
              },
            },
          };
        }
        return message;
      },
    });

    socket.ev.on("creds.update", auth.saveCreds);

    socket.ev.on("connection.update", ({ connection, qr }) => {
      if (connection === 'open') {
        console.log("WhatsApp Active..");
        console.log('Bot ID:', socket.user.id);
        logToFile("WhatsApp Active..");
        logToFile('Bot ID: ' + socket.user.id);
        qrCode = null;
        reconnectAttempts = 0;
      } else if (connection === 'close') {
        console.log("WhatsApp Closed..");
        logToFile("WhatsApp Closed..");
        reconnect();
      } else if (connection === 'connecting') {
        console.log('WhatsApp Connecting');
        logToFile('WhatsApp Connecting');
      }
      if (qr) {
        console.log('New QR Code received');
        logToFile('New QR Code received');
        qrcode.generate(qr, { small: true });
        qrCode = qr;
      }
    });

    socket.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const message = messages[0];
        console.log('Raw message:', JSON.stringify(message, null, 2));
        logToFile('Raw message: ' + JSON.stringify(message, null, 2));

        let pesan = '';
        let isGroupMessage = message.key.remoteJid.endsWith('@g.us');
        let isMentioned = false;

        if (message.message && message.message.conversation) {
          pesan = decodeMessage(message.message.conversation);
        } else if (message.message && message.message.extendedTextMessage && message.message.extendedTextMessage.text) {
          pesan = decodeMessage(message.message.extendedTextMessage.text);
        } else {
          console.log('Unsupported message type');
          logToFile('Unsupported message type');
          return;
        }

        const botNumber = socket.user.id.split(':')[0];
        isMentioned = pesan.includes(`@${botNumber}`);

        const phone = message.key.remoteJid;
        console.log('Decoded message:', pesan);
        logToFile('Decoded message: ' + pesan);
        console.log('Is Group Message:', isGroupMessage);
        console.log('Is Mentioned:', isMentioned);
        console.log('Bot Number:', botNumber);
        logToFile(`Is Group Message: ${isGroupMessage}, Is Mentioned: ${isMentioned}, Bot Number: ${botNumber}`);

        if (!message.key.fromMe) {
          if (!isGroupMessage || (isGroupMessage && isMentioned)) {
            console.log('Processing message. isGroupMessage:', isGroupMessage, 'isMentioned:', isMentioned);
            logToFile(`Processing message. isGroupMessage: ${isGroupMessage}, isMentioned: ${isMentioned}`);

            if (pesan.startsWith('ingatkan')) {
              const reminderDetails = parseReminderMessage(pesan);
              if (reminderDetails) {
                const { description, time } = reminderDetails;
                const initialMessage = `P. ${description}`;
                
                // Kirim pesan ke Flowise AI
                const initialResponse = await query({ "question": initialMessage });
                console.log('Initial API response:', initialResponse);
                logToFile('Initial API response: ' + JSON.stringify(initialResponse));
                await sendMessageWithRetry(socket, phone, { text: initialResponse.text });

                const delayMs = time - new Date();
                setTimeout(async () => {
                  const reminderMessage = `P.A. ${description}`;
                  
                  // Kirim pesan ke Flowise AI
                  const reminderResponse = await query({ "question": reminderMessage });
                  console.log('Reminder API response:', reminderResponse);
                  logToFile('Reminder API response: ' + JSON.stringify(reminderResponse));
                  await sendMessageWithRetry(socket, phone, { text: reminderResponse.text });
                }, delayMs);
              } else {
                await sendMessageWithRetry(socket, phone, { text: 'Format tidak valid. Gunakan "ingatkan <deskripsi> <waktu>".' });
              }
            } else {
              const response = await query({ "question": pesan });
              console.log('API response:', response);
              logToFile('API response: ' + JSON.stringify(response));
              const { text } = response;
              await sendMessageWithRetry(socket, phone, { text: text });
            }
          } else {
            console.log('Pesan grup diabaikan karena bot tidak di-tag');
            logToFile('Pesan grup diabaikan karena bot tidak di-tag');
          }
        }
      } catch (error) {
        console.error('Error saat memproses pesan:', error);
        logToFile('Error saat memproses pesan: ' + error.message);
        if (error.name === 'TimeoutError' || (error.output && error.output.statusCode === 408)) {
          console.log('Timeout saat mengirim pesan. Mencoba reconnect...');
          logToFile('Timeout saat mengirim pesan. Mencoba reconnect...');
          reconnect();
        } else {
          console.log('Error tidak dikenal:', error.message);
          logToFile('Error tidak dikenal: ' + error.message);
        }
      }
    });

  } catch (error) {
    console.error('Error saat menghubungkan ke WhatsApp:', error);
    logToFile('Error saat menghubungkan ke WhatsApp: ' + error.message);
    reconnect();
  }
}

async function sendMessageWithRetry(socket, recipient, message, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await delay(i * 2000);
      await socket.sendMessage(recipient, message);
      console.log('Pesan berhasil dikirim');
      logToFile('Pesan berhasil dikirim');
      return;
    } catch (error) {
      console.error(`Gagal mengirim pesan (percobaan ${i + 1}):`, error);
      logToFile(`Gagal mengirim pesan (percobaan ${i + 1}): ${error.message}`);
      if (i === maxRetries - 1) {
        throw error;
      }
    }
  }
}

function reconnect() {
  if (reconnectAttempts < maxReconnectAttempts) {
    console.log(`Mencoba reconnect... (Percobaan ${reconnectAttempts + 1})`);
    logToFile(`Mencoba reconnect... (Percobaan ${reconnectAttempts + 1})`);
    setTimeout(() => {
      console.log('Memulai ulang koneksi WhatsApp...');
      logToFile('Memulai ulang koneksi WhatsApp...');
      connectWhatsapp();
    }, 10000);
    reconnectAttempts++;
  } else {
    console.log('Gagal reconnect setelah beberapa percobaan. Silakan restart aplikasi.');
    logToFile('Gagal reconnect setelah beberapa percobaan. Silakan restart aplikasi.');
  }
}

async function query(data) {
  try {
    const response = await fetch(
      "https://flowisefrest.onrender.com/api/v1/prediction/e5d4a781-a3a5-4631-8cdd-3972b57bcba7",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
      }
    );
    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Error saat melakukan query:', error);
    logToFile('Error saat melakukan query: ' + error.message);
    throw error;
  }
}

function parseReminderMessage(message) {
  const now = new Date();
  let description, time;

  const timePatterns = [
    { regex: /jam (\d{1,2}):(\d{2})/, parser: (match) => setHours(setMinutes(now, match[2]), match[1]) },
    { regex: /besok jam (\d{1,2})/, parser: (match) => setHours(addDays(now, 1), match[1]) },
    { regex: /nanti siang/, parser: () => setHours(now, 12) },
    { regex: /nanti sore/, parser: () => setHours(now, 16) },
    { regex: /nanti malam/, parser: () => setHours(now, 18) },
    { regex: /tanggal (\d{1,2})/, parser: (match) => setHours(setMinutes(setDate(now, match[1]), 0), 0) }
  ];

  for (const pattern of timePatterns) {
    const match = message.match(pattern.regex);
    if (match) {
      description = message.split(pattern.regex)[0].trim();
      const localTime = pattern.parser(match);
      time = zonedTimeToUtc(localTime, timeZone);
      break;
    }
  }

  return time ? { description, time } : null;
}

module.exports = { connectWhatsapp, getQRCode: () => qrCode };