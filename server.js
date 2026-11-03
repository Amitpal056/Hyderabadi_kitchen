const express = require('express');
const http = require('http');
const session = require('express-session');
const { Server } = require('socket.io');

let outlets = [], menuItems = [];
try {
    const mock = require('./data/mockData');
    outlets = mock.outlets || [];
    menuItems = mock.menuItems || [];
} catch (e) {
    console.warn("Using fallback mock data.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(session({
    secret: 'company-a-secret-key-2026',
    resave: false,
    saveUninitialized: false
}));

app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    if (req.session.user && req.session.user.role === 'customer' && !req.session.cart) {
        req.session.cart = [];
    }
    next();
});

let activeOrders = [];

function isAuthenticated(req, res, next) {
    if (req.session.user) {
        return next();
    }
    res.redirect('/login');
}

function requireRole(role) {
    return (req, res, next) => {
        if (req.session.user && req.session.user.role === role) {
            return next();
        }
        res.status(403).send(`<h1>403 Forbidden</h1><p>Access denied.</p><a href="/login">Switch Account</a>`);
    };
}

// --- AUTH ROUTES ---
app.get('/login', (req, res) => {
    res.render('auth/login', { outlets });
});

app.post('/login', (req, res) => {
    const { role, outletId } = req.body;
    
    if (role === 'customer') {
        req.session.user = { name: 'Amit Pal (Customer)', role: 'customer' };
        req.session.cart = [];
        return res.redirect('/');
    } else if (role === 'kitchen') {
        const outlet = outlets.find(o => o.id === outletId) || outlets[0];
        req.session.user = { name: `Kitchen Staff (${outlet.name})`, role: 'kitchen', outletId: outlet.id };
        return res.redirect(`/kitchen/${outlet.id}`);
    } else if (role === 'admin') {
        req.session.user = { name: 'Central Operations Manager', role: 'admin' };
        return res.redirect('/admin/dashboard');
    }
    res.redirect('/login');
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// --- CUSTOMER ROUTES ---
app.get('/', isAuthenticated, requireRole('customer'), (req, res) => {
    res.render('customer/menu', { outlets, menuItems, cartCount: (req.session.cart || []).reduce((acc, i) => acc + i.qty, 0) });
});

app.post('/cart/add', isAuthenticated, requireRole('customer'), (req, res) => {
    const { itemId, qty } = req.body;
    const quantity = parseInt(qty) || 1;
    const item = menuItems.find(i => i.id === itemId);

    if (item) {
        if (!req.session.cart) req.session.cart = [];
        const existing = req.session.cart.find(i => i.id === itemId);
        if (existing) {
            existing.qty += quantity;
        } else {
            req.session.cart.push({ id: item.id, name: item.name, price: item.price, qty: quantity });
        }
    }
    res.redirect('/');
});

// Decrease item quantity or remove if it reaches 0
app.get('/cart/decrease/:id', isAuthenticated, requireRole('customer'), (req, res) => {
    const itemId = req.params.id;
    if (req.session.cart) {
        const existing = req.session.cart.find(i => i.id === itemId);
        if (existing) {
            existing.qty -= 1;
            if (existing.qty <= 0) {
                req.session.cart = req.session.cart.filter(i => i.id !== itemId);
            }
        }
    }
    res.redirect('/cart');
});

app.get('/cart/remove/:id', isAuthenticated, requireRole('customer'), (req, res) => {
    const itemId = req.params.id;
    if (req.session.cart) {
        req.session.cart = req.session.cart.filter(i => i.id !== itemId);
    }
    res.redirect('/cart');
});

app.get('/cart', isAuthenticated, requireRole('customer'), (req, res) => {
    const cart = req.session.cart || [];
    let itemTotal = cart.reduce((acc, i) => acc + (i.price * i.qty), 0);
    res.render('customer/cart', { cart, itemTotal });
});

app.post('/place-order', isAuthenticated, requireRole('customer'), (req, res) => {
    const cart = req.session.cart || [];
    if (cart.length === 0) return res.redirect('/cart');

    const itemTotal = cart.reduce((acc, i) => acc + (i.price * i.qty), 0);
    const deliveryFee = 56;
    const discount = req.body.redeemed === 'true' ? 24 : 0;
    const finalTotal = itemTotal + deliveryFee - discount;

    const newOrder = {
        id: 'WEB-' + Math.floor(100000 + Math.random() * 900000),
        outletId: 'kondapur',
        items: cart.map(i => ({ qty: i.qty, name: i.name })),
        total: finalTotal,
        payment: req.body.paymentMethod || 'UPI',
        status: 'Preparing',
        isLate: false,
        createdAt: new Date().toLocaleTimeString()
    };

    activeOrders.unshift(newOrder);
    io.emit('new-order-received', newOrder);

    req.session.cart = [];
    res.redirect(`/order/${newOrder.id}`);
});

app.get('/order/:id', isAuthenticated, requireRole('customer'), (req, res) => {
    const order = activeOrders.find(o => o.id === req.params.id) || {
        id: req.params.id,
        status: 'Preparing',
        items: []
    };
    res.render('customer/order-status', { order });
});

// --- KITCHEN ROUTES ---
app.get('/kitchen/:outletId', isAuthenticated, requireRole('kitchen'), (req, res) => {
    if (req.session.user.outletId !== req.params.outletId) {
        return res.status(403).send(`<h1>403 Forbidden</h1><p>Access denied.</p>`);
    }
    const outlet = outlets.find(o => o.id === req.params.outletId) || outlets[0];
    const outletOrders = activeOrders.filter(o => o.outletId === outlet.id);
    res.render('kitchen/kds', { outlet, outletOrders });
});

// --- ADMIN / MANAGER ROUTES ---
app.get('/admin/dashboard', isAuthenticated, requireRole('admin'), (req, res) => {
    res.render('admin/dashboard', { outlets, activeOrders });
});

app.get('/admin/cms', isAuthenticated, requireRole('admin'), (req, res) => {
    res.render('admin/cms', { menuItems, outlets });
});

io.on('connection', (socket) => {
    socket.on('update-order-status', ({ orderId, status }) => {
        const order = activeOrders.find(o => o.id === orderId);
        if (order) {
            const stateRank = { 'Preparing': 1, 'Ready for pickup': 2, 'Rider Handoff': 3 };
            if ((stateRank[status] || 1) < (stateRank[order.status] || 1)) return;
            order.status = status;
            io.emit('order-updated', order);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Platform running at http://localhost:${PORT}`);
});