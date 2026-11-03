const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  qty: { type: Number, default: 1 },
  name: { type: String, required: true }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  customerId: { type: String, default: 'guest' },
  email: { type: String, lowercase: true, trim: true, default: '' },
  customerName: { type: String, default: 'Customer' },
  phone: { type: String, default: '+91 90000 00000' },
  outletId: { type: String, required: true },
  items: [itemSchema],
  total: { type: Number, required: true },
  payment: { type: String, default: 'UPI' },
  paymentStatus: { type: String, default: 'Test payment approved' },
  status: { type: String, default: 'In Progress' },
  aiPrepMinutes: { type: Number, default: 20 },
  promisedMinutes: { type: Number, default: 20 },
  promisedAt: { type: String, default: null },
  prepStartedAt: { type: Number, default: null },
  managerOverride: { type: Boolean, default: false },
  alertSentAt: { type: String, default: null },
  createdAtMs: { type: Number, default: Date.now },
  createdAt: { type: String, default: () => new Date().toLocaleTimeString() }
}, { collection: 'orders' });

module.exports = mongoose.model('Order', orderSchema);
