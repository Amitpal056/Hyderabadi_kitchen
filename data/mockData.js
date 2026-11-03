const outlets = [
    { id: 'kondapur', name: 'Kondapur Outlet', fssai: '10020047001892' },
    { id: 'gachibowli', name: 'Gachibowli Cloud Kitchen', fssai: '10020047001893' },
    { id: 'kukatpally', name: 'Kukatpally Outlet', fssai: '10020047001894' }
];

const menuItems = [
    { 
        id: '1', 
        name: 'Chicken Dum Biryani Family Pack', 
        description: 'Aromatic basmati rice layered with tender chicken and traditional spices', 
        price: 1180, 
        isVeg: false, 
        inStock: true,
        image: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=500' 
    },
    { 
        id: '2', 
        name: 'Veg Biryani', 
        description: 'Assorted fresh vegetables cooked with fragrant basmati rice and hand-ground spices', 
        price: 320, 
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

const initialOrders = [
    {
        id: 'WEB-778120',
        outletId: 'kondapur',
        items: [{ qty: 1, name: 'Chicken Dum Biryani Family Pack' }, { qty: 2, name: 'Double ka meetha' }],
        total: 1180,
        payment: 'UPI',
        status: 'Preparing',
        isLate: false
    },
    {
        id: 'WEB-778131',
        outletId: 'gachibowli',
        items: [{ qty: 2, name: 'Veg Biryani' }, { qty: 1, name: 'Mirchi ka salan' }],
        total: 640,
        payment: 'Card',
        status: 'Ready for pickup',
        isLate: false
    },
    {
        id: 'WEB-778146',
        outletId: 'kukatpally',
        items: [{ qty: 3, name: 'Mutton Haleem' }],
        total: 1050,
        payment: 'UPI',
        status: 'Late by 4 minutes',
        isLate: true
    }
];

module.exports = {
    outlets,
    menuItems,
    initialOrders
};