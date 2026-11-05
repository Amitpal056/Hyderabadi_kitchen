const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
  cartKey: String,
  id: String,
  name: String,
  portion: String,
  addon: String,
  price: Number,
  qty: Number
}, { _id: false });

const customerSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, default: 'Customer' },
  phone: { type: String, default: '' },
  smsOptIn: { type: Boolean, default: false },
  preferredOutlet: { type: String, default: 'kondapur' },
  cart: { type: [cartItemSchema], default: [] }
}, { timestamps: true, collection: 'customers' });

module.exports = mongoose.model('Customer', customerSchema);
