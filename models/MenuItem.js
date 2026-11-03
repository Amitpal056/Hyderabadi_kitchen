const mongoose = require('mongoose');

const menuItemSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  price: { type: Number, required: true },
  isVeg: { type: Boolean, default: false },
  inStock: { type: Boolean, default: true },
  image: { type: String, default: '' }
}, { collection: 'menu_items' });

module.exports = mongoose.model('MenuItem', menuItemSchema);
