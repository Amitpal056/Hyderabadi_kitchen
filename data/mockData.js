const outlets = [
    { id: 'kondapur', name: 'Kondapur Outlet', radius: 'Within 5 km', fssai: '10020047001892' },
    { id: 'gachibowli', name: 'Gachibowli Cloud Kitchen', radius: 'Within 7 km', fssai: '10020047001893' },
    { id: 'kukatpally', name: 'Kukatpally Outlet', radius: 'Within 6 km', fssai: '10020047001894' }
];

const menuItems = [
    { 
        id: '1', 
        name: 'Chicken Dum Biryani', 
        description: 'Aromatic basmati rice layered with tender chicken and traditional spices', 
        price: 340, 
        isVeg: false, 
        inStock: true,
        image: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=500' 
    },
    { 
        id: '2', 
        name: 'Veg Biryani', 
        description: 'Assorted fresh vegetables cooked with fragrant basmati rice and hand-ground spices', 
        price: 280, 
        isVeg: true, 
        inStock: true,
        image: 'https://images.unsplash.com/photo-1645177628172-a94c1f96e6db?w=500' 
    },
    { 
        id: '3', 
        name: 'Mutton Haleem', 
        description: 'Slow-cooked pounded wheat, lentils, and tender mutton rich in flavor', 
        price: 350, 
        isVeg: false, 
        inStock: true,
        image: 'https://images.unsplash.com/photo-1543353071-10c8ba85a904?w=500' 
    }
];

module.exports = { outlets, menuItems, initialOrders: [] };