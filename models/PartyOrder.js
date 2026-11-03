const mongoose = require('mongoose');

const partyOrderSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  customerId: { type: String, default: 'guest' },
  email: { type: String, lowercase: true, trim: true, default: '' },
  customerName: { type: String, required: true },
  phone: { type: String, required: true },
  guests: { type: Number, required: true },
  deliveryDate: { type: String, required: true },
  outletId: { type: String, required: true },
  details: { type: String, default: '' },
  status: { type: String, default: 'Pending Manager Confirmation' },
  createdAt: { type: String, default: () => new Date().toLocaleString() }
}, { collection: 'party_orders' });

module.exports = mongoose.model('PartyOrder', partyOrderSchema);
