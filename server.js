require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const mqtt = require('mqtt');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');

const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.json());

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){ fs.mkdirSync(uploadDir); }
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/'); },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'prod-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ==========================================
// អនុគមន៍បង្កើតកូដស្តង់ដារ EMVCo KHQR
// ==========================================
function generateCRC16(str) {
    let crc = 0xFFFF;
    const polynomial = 0x1021;
    for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        for (let b = 0; b < 8; b++) {
            let bit = ((code >> (7 - b)) & 1) === 1;
            let c15 = ((crc >> 15) & 1) === 1;
            crc <<= 1;
            if (bit ^ c15) crc ^= polynomial;
        }
    }
    crc &= 0xFFFF;
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

function toTLV(tag, value) {
    const len = value.length.toString().padStart(2, '0');
    return `${tag}${len}${value}`;
}

function generateOfficialKHQR(transactionId, amount) {
    let qrFields = "";
    qrFields += toTLV("00", "01");
    qrFields += toTLV("01", "12"); 
    const subFields = toTLV("00", "kh.com.bakong") + toTLV("01", "chantha_nuon@aba");
    qrFields += toTLV("30", subFields);
    qrFields += toTLV("52", "5999"); 
    qrFields += toTLV("53", "116");  
    qrFields += toTLV("54", amount.toString()); 
    qrFields += toTLV("58", "KH");
    qrFields += toTLV("59", "Vending Machine Bavet");
    qrFields += toTLV("60", "Svay Rieng");
    const infoField = toTLV("01", transactionId);
    qrFields += toTLV("62", infoField);
    qrFields += "6304"; 
    return qrFields + generateCRC16(qrFields);
}

async function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, { chat_id: chatId, text: message, parse_mode: 'Markdown' });
    } catch (error) { console.error('[TELEGRAM ERROR] ❌', error.message); }
}

const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vending_db',
    port: process.env.DB_PORT || 3307,
    waitForConnections: true,
    connectionLimit: 10
});

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com');
mqttClient.on('connect', () => console.log('Connected to MQTT Broker'));

app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM products ORDER BY slot_number ASC');
        res.json({ success: true, products: rows });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.put('/api/products/:id', upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, price, stock } = req.body;
        let query = 'UPDATE products SET name = ?, price = ?, stock = ? WHERE id = ?';
        let params = [name, price, stock, id];
        if (req.file) {
            const imageUrl = '/uploads/' + req.file.filename;
            query = 'UPDATE products SET name = ?, price = ?, stock = ?, image_url = ? WHERE id = ?';
            params = [name, price, stock, imageUrl, id];
        }
        await db.execute(query, params);
        res.json({ success: true, message: 'Product updated successfully' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 💡 API បង្កើតប្រតិបត្តិការទិញគាំទ្រទាំង ទិញភ្លាមៗ និងទិញតាមកន្ត្រក (Cart)
app.post('/api/create-transaction', async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const { machine_id, items } = req.body; // items ជា Array: [{product_id, slot_number, quantity, price}]

        if (!items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'គ្មានទំនិញនៅក្នុងកន្ត្រកទេ!' });
        }

        let totalAmount = 0;
        
        // ឆែកស្តុកគ្រប់មុខទំនិញទាំងអស់សិន
        for (const item of items) {
            const [prod] = await connection.execute('SELECT name, stock FROM products WHERE id = ?', [item.product_id]);
            if (prod.length === 0 || prod[0].stock < item.quantity) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: `⚠️ សុំទោសផងបង! ${prod[0] ? prod[0].name : 'ទំនិញ'} មិនមានស្តុកគ្រប់គ្រាន់សម្រាប់ការកុម្ម៉ង់ឡើយ។` });
            }
            totalAmount += item.price * item.quantity;
        }

        const transactionId = 'TXN_' + Date.now();
        
        // បញ្ចូលទៅក្នុងតារាង transactions មេ (ទុក slot_number = 0 ព្រោះមានច្រើនថត)
        await connection.execute(
            'INSERT INTO transactions (id, machine_id, product_id, slot_number, amount, status) VALUES (?, ?, ?, ?, ?, ?)',
            [transactionId, machine_id, 0, 0, totalAmount, 'pending']
        );

        // បញ្ចូលទំនិញលម្អិតទៅក្នុង transaction_items
        for (const item of items) {
            await connection.execute(
                'INSERT INTO transaction_items (transaction_id, product_id, slot_number, quantity, price) VALUES (?, ?, ?, ?, ?)',
                [transactionId, item.product_id, item.slot_number, item.quantity, item.price]
            );
        }

        await connection.commit();
        const officialQRString = generateOfficialKHQR(transactionId, totalAmount);
        res.status(201).json({ success: true, transactionId, qr_string: officialQRString, totalAmount });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// Webhook ទទួលប្រាក់ (កាត់ស្តុកគ្រប់មុខទំនិញក្នុងកន្ត្រក និងទម្លាក់ទឹកម្តងមួយៗ)
app.post('/webhook/payment', async (req, res) => {
    try {
        const { transactionId, status, paymentRef } = req.body;
        if (status === 'COMPLETED') {
            const [rows] = await db.execute('SELECT amount FROM transactions WHERE id = ? AND status = ?', [transactionId, 'pending']);
            
            if (rows.length > 0) {
                const totalAmount = rows[0].amount;
                
                // ១. ដូរស្ថានភាពប្រកាសជោគជ័យ
                await db.execute('UPDATE transactions SET status = ?, payment_ref = ? WHERE id = ?', ['success', paymentRef, transactionId]);
                
                // ២. ទាញយកទំនិញទាំងអស់ក្នុងកន្ត្រកមកដំណើរការ
                const [items] = await db.execute(
                    'SELECT ti.*, p.name FROM transaction_items ti JOIN products p ON ti.product_id = p.id WHERE ti.transaction_id = ?', 
                    [transactionId]
                );

                let telegramItemDetails = "";

                // ៣. រក្សា loop ដកស្តុក និងបាញ់ MQTT ទៅ ESP32
                for (const item of items) {
                    // កាត់ស្តុកក្នុង DB
                    await db.execute('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.product_id]);
                    
                    // បាញ់បញ្ជាទៅម៉ូទ័រ (ផ្ញើចំនួនដងទៅតាម quantity)
                    for(let i=0; i < item.quantity; i++) {
                        const dispensePayload = JSON.stringify({ action: "DISPENSE", slot: item.slot_number });
                        mqttClient.publish(`machine/dispense`, dispensePayload, { qos: 1 });
                        // ពន្យារពេលបន្តិច ដើម្បីកុំឱ្យម៉ូទ័រវិលជាន់គ្នា
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                    telegramItemDetails += `- ${item.name} x ${item.quantity} (Slot ${item.slot_number})\n`;
                }

                io.emit('payment_success', { transactionId });

                // ៤. ផ្ញើរបាយការណ៍កន្ត្រកចូល Telegram
                const telegramMsg = `🔔 *[លុយចូលកន្ត្រកទំនិញ]*\n\n` +
                                    `🛒 មុខទំនិញរួមមាន៖\n${telegramItemDetails}\n` +
                                    `💰 ទឹកប្រាក់សរុប៖ *${parseFloat(totalAmount).toLocaleString()} ៛*\n` +
                                    `🆔 លេខប្រតិបត្តិការ៖ \`${transactionId}\``;
                sendTelegramAlert(telegramMsg);

                return res.status(200).json({ success: true, message: 'Dispense triggered for all items' });
            } else {
                return res.status(400).json({ success: false, message: 'Transaction already processed or not found' });
            }
        }
        res.status(400).json({ success: false, message: 'Transaction failed' });
    } catch (error) {
        console.error('Webhook Error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

io.on('connection', (socket) => {});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Backend Server running on port ${PORT}`));