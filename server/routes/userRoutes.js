const express = require('express');
const { getWorkers, getWorkerById, updateProfile } = require('../controllers/userController');
const {
  getMyAddresses,
  createAddress,
  updateAddress,
  setDefaultAddress,
  deleteAddress
} = require('../controllers/addressController');
const { protect, forbidRoles } = require('../middlewares/authMiddleware');

const router = express.Router();

// 'Find Workers' search directory: restricted from Worker accounts
router.get('/workers', forbidRoles('Worker'), getWorkers);
router.get('/workers/:id', getWorkerById);
router.get('/addresses', protect, getMyAddresses);
router.post('/addresses', protect, createAddress);
router.put('/addresses/:id', protect, updateAddress);
router.patch('/addresses/:id/default', protect, setDefaultAddress);
router.delete('/addresses/:id', protect, deleteAddress);
router.put('/profile', protect, updateProfile);

module.exports = router;
