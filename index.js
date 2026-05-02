const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const admin = require('firebase-admin');
const cors = require('cors');
const axios = require('axios');

puppeteer.use(StealthPlugin());
const app = express();
app.use(cors());
app.use(express.json());

// --- FIREBASE INITIALIZATION ---
// Render ke Environment Variable 'FIREBASE_SERVICE_ACCOUNT' se key uthayega
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// Browser instances ko track karne ke liye
let activeLogins = {};

// --- SECTION 1: USER AUTH (Gmail OTP) ---

// Send OTP via your Render API
app.get('/api/auth/send', async (req, res) => {
    const { email } = req.query;
    try {
        const response = await axios.get(`https://otp-server-a1-api.onrender.com/send?email=${email}`);
        res.json(response.data);
    } catch (e) { res.status(500).json({ success: false }); }
});

// Verify OTP & Create User in Firestore
app.get('/api/auth/verify', async (req, res) => {
    const { email, otp } = req.query;
    try {
        const verify = await axios.get(`https://otp-server-a1-api.onrender.com/verify?email=${email}&otp=${otp}`);
        if (verify.data.success) {
            const userRef = db.collection('users').doc(email);
            const doc = await userRef.get();
            if (!doc.exists) {
                await userRef.set({
                    email: email,
                    balance: 0,
                    apiKey: "SK-" + Math.random().toString(36).substring(2, 12).toUpperCase(),
                    cashierStatus: 'inactive',
                    joinedAt: new Date().toISOString()
                });
            }
            res.json({ success: true, user: (await userRef.get()).data() });
        } else { res.json({ success: false, message: "Invalid OTP" }); }
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- SECTION 2: AMAZON PAY LOGIN AUTOMATION ---

// Step 1: Start Browser & Enter Phone Number
app.post('/api/amazon/start', async (req, res) => {
    const { phone, email } = req.body;
    try {
        const browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
        
        // Amazon Login URL
        await page.goto('https://www.amazon.in/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.in%2Famazonpay%2Ftransactions&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0', { waitUntil: 'networkidle2' });

        await page.type('#ap_email', phone);
        await page.click('#continue');
        
        // Save session for OTP step
        activeLogins[email] = { browser, page, phone };
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Step 2: Verify Amazon OTP & Capture Cookies
app.post('/api/amazon/verify', async (req, res) => {
    const { email, otp } = req.body;
    const session = activeLogins[email];
    if (!session) return res.json({ success: false, message: "Session Expired" });

    try {
        await session.page.type('input[name="otpCode"]', otp); 
        await session.page.click('#auth-signin-button');
        await session.page.waitForNavigation({ waitUntil: 'networkidle2' });

        const cookies = await session.page.cookies();
        
        // Save Cookies to Firestore & Activate Cashier
        await db.collection('users').doc(email).update({
            cashierStatus: 'active',
            amazonPhone: session.phone,
            cookies: cookies,
            lastLogin: new Date().toISOString()
        });

        await session.browser.close();
        delete activeLogins[email];
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, message: "Amazon OTP failed" });
    }
});

// --- SECTION 3: AUTOMATIC PAYMENT MONITORING ---

async function monitorAllUsers() {
    console.log("Checking Amazon History for all active cashiers...");
    const activeUsers = await db.collection('users').where('cashierStatus', '==', 'active').get();
    
    for (const doc of activeUsers.docs) {
        const userData = doc.data();
        const userEmail = doc.id;

        const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
        const page = await browser.newPage();
        
        try {
            await page.setCookie(...userData.cookies);
            await page.goto('https://www.amazon.in/amazonpay/transactions', { waitUntil: 'networkidle2' });

            const transactions = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('.a-box-inner'));
                return rows.map(r => ({
                    text: r.innerText,
                    status: r.querySelector('.transaction-status')?.innerText || ""
                }));
            });

            for (let txn of transactions) {
                // Unique Note Match (PAYOUPI...)
                const match = txn.text.match(/PAYOUPI[A-Z0-9]+/);
                if (match && txn.status.includes("Success")) {
                    const noteId = match[0];
                    
                    // Verify in Firestore orders
                    const orderSnap = await db.collection('orders')
                        .where('payment_note', '==', noteId)
                        .where('status', '==', 'pending').get();

                    orderSnap.forEach(async (orderDoc) => {
                        await orderDoc.ref.update({
                            status: 'Completed',
                            verifiedAt: new Date().toISOString()
                        });
                        console.log(`Verified Order: ${orderDoc.id} with Note: ${noteId}`);
                    });
                }
            }
        } catch (e) {
            console.log(`Monitoring error for ${userEmail}:`, e.message);
        } finally {
            await browser.close();
        }
    }
}

// Har 2 minute mein automatic check chalega
setInterval(monitorAllUsers, 120000);

// Server Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend Server Running on Port ${PORT}`));
