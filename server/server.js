const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const prisma = require('./config/prisma');
const { ensureAuthorizedChatParticipants } = require('./controllers/chatController');

dotenv.config({ path: path.resolve(__dirname, '.env') });

const connectDB = require('./config/db');

// Import Routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const jobRoutes = require('./routes/jobRoutes');
const appRoutes = require('./routes/appRoutes');
const chatRoutes = require('./routes/chatRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const adminRoutes = require('./routes/adminRoutes');
const escrowRoutes = require('./routes/escrowRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const notificationRoutes = require('./routes/notificationRoutes');

const app = express();
const server = http.createServer(app);
const activeTracking = new Map();

const bookingTrackingRoom = (bookingId) => `booking:${bookingId}`;

const mapRole = (role) => {
  switch (role) {
    case 'WORKER':
      return 'Worker';
    case 'ADMIN':
      return 'Admin';
    default:
      return 'Customer';
  }
};

const isValidCoordinate = (value, min, max) => Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;

const persistWorkerLocation = async ({ bookingId, workerId, latitude, longitude }) => {
  if (!bookingId || !workerId || !isValidCoordinate(latitude, -90, 90) || !isValidCoordinate(longitude, -180, 180)) {
    return false;
  }

  try {
    const workerProfile = await prisma.workerProfile.findUnique({
      where: { userId: String(workerId) }
    });

    if (!workerProfile) {
      return false;
    }

    await prisma.workerProfile.update({
      where: { id: workerProfile.id },
      data: {
        latitude: Number(latitude),
        longitude: Number(longitude)
      }
    });

    return true;
  } catch (error) {
    console.error('[Socket Tracking] Worker location persistence failed:', error.message);
    return false;
  }
};

const verifyBookingTrackingAccess = async ({ bookingId, userId, role }) => {
  if (!bookingId || !userId) {
    return { authorized: false, reason: 'Missing bookingId or userId', booking: null };
  }

  try {
    const booking = await prisma.booking.findUnique({
      where: { id: String(bookingId) },
      select: {
        id: true,
        status: true,
        customerId: true,
        workerId: true
      }
    });

    if (!booking) {
      return { authorized: false, reason: 'Booking not found', booking: null };
    }

    if (booking.status === 'CANCELLED' || booking.status === 'COMPLETED') {
      if (activeTracking.has(String(bookingId))) {
        activeTracking.delete(String(bookingId));
      }
      return { authorized: false, reason: 'Booking is no longer active', booking };
    }

    if (role === 'Worker' && booking.workerId !== userId) {
      return { authorized: false, reason: 'Only the assigned worker may manage this booking tracking', booking };
    }

    if (role === 'Customer' && booking.customerId !== userId) {
      return { authorized: false, reason: 'Only the booking owner may subscribe to this booking location', booking };
    }

    if (role !== 'Worker' && role !== 'Customer') {
      return { authorized: false, reason: 'Role not authorized for tracking', booking };
    }

    return { authorized: true, reason: 'Authorized', booking };
  } catch (error) {
    console.error('[Socket Tracking] Access verification failed:', error);
    return { authorized: false, reason: 'Server error validating booking access', booking: null };
  }
};

// Middleware
app.use(express.json());
app.use(cors({
  origin: '*', // Allow all origins for dev / local testing
  methods: ['GET', 'POST', 'PUT', 'DELETE']
}));

// Socket.io initialization
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.use(async (socket, next) => {
  const headerToken = socket.handshake.headers.authorization;
  const socketToken = socket.handshake.auth?.token;
  const rawToken = typeof socketToken === 'string' ? socketToken : (typeof headerToken === 'string' ? headerToken : '');
  const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;

  if (!token) {
    return next(new Error('Socket auth failed: missing token'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'localhire_super_secret_jwt_key_2026_dev');
    const user = await prisma.user.findUnique({
      where: { id: String(decoded.id) },
      select: { id: true, role: true }
    });

    if (!user) {
      return next(new Error('Socket auth failed: user not found'));
    }

    socket.user = {
      id: user.id,
      role: mapRole(user.role)
    };
    return next();
  } catch (error) {
    console.error('[Socket Auth] Token verification failed:', error.message);
    return next(new Error('Socket auth failed: invalid token'));
  }
});

// Socket.io connection logic
io.on('connection', (socket) => {
  console.log(`[Socket] User connected: ${socket.id}`);

  socket.on('join_room', async (roomId) => {
    if (!roomId || typeof roomId !== 'string') {
      socket.emit('chat:error', { message: 'Invalid chat room reference.' });
      return;
    }

    const userIds = roomId.split('_').filter(Boolean);
    if (userIds.length !== 2) {
      socket.emit('chat:error', { message: 'Chat room is not linked to a valid conversation.' });
      return;
    }

    const [participantA, participantB] = userIds;
    const otherUserId = String(socket.user.id) === String(participantA) ? participantB : participantA;

    const auth = await ensureAuthorizedChatParticipants(socket.user.id, otherUserId);
    if (!auth.authorized) {
      socket.emit('chat:error', { message: auth.message });
      return;
    }

    socket.join(roomId);
    socket.data.chatRoom = roomId;
    console.log(`[Socket] Socket ${socket.id} joined authorized room: ${roomId}`);
  });

  socket.on('send_message', async (data) => {
    try {
      if (!data || !data.roomId || !data.content) {
        socket.emit('chat:error', { message: 'Message content and room are required.' });
        return;
      }

      const senderId = String(socket.user.id);
      const roomParticipants = String(data.roomId).split('_').filter(Boolean);
      const otherUserId = roomParticipants.find((id) => String(id) !== senderId);

      if (!otherUserId) {
        socket.emit('chat:error', { message: 'Could not resolve the recipient for this chat room.' });
        return;
      }

      const auth = await ensureAuthorizedChatParticipants(senderId, otherUserId);
      if (!auth.authorized) {
        socket.emit('chat:error', { message: auth.message });
        return;
      }

      const content = String(data.content).trim();
      if (!content) {
        socket.emit('chat:error', { message: 'Message content cannot be empty.' });
        return;
      }

      const [user1Id, user2Id] = [senderId, otherUserId].sort();
      const conversation = await prisma.conversation.upsert({
        where: { user1Id_user2Id: { user1Id, user2Id } },
        update: { lastMessageAt: new Date() },
        create: { user1Id, user2Id, lastMessageAt: new Date() }
      });

      const message = await prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          senderId,
          receiverId: otherUserId,
          content,
          isRead: false
        }
      });

      const payload = {
        id: message.id,
        roomId: data.roomId,
        senderId,
        receiverId: otherUserId,
        content: message.content,
        createdAt: message.createdAt,
        isRead: message.isRead,
        conversationId: message.conversationId
      };

      io.to(data.roomId).emit('receive_message', payload);
    } catch (error) {
      console.error('[Socket Chat] Message save failed:', error);
      socket.emit('chat:error', { message: 'Failed to send message. Please try again.' });
    }
  });

  socket.on('tracking:subscribe', async ({ bookingId } = {}) => {
    const { authorized, reason, booking } = await verifyBookingTrackingAccess({
      bookingId,
      userId: socket.user?.id,
      role: socket.user?.role
    });

    if (!authorized) {
      socket.emit('tracking:error', { bookingId, message: reason });
      return;
    }

    if (socket.user.role !== 'Customer') {
      socket.emit('tracking:error', { bookingId, message: 'Only the booking owner can subscribe to live tracking' });
      return;
    }

    const room = bookingTrackingRoom(bookingId);
    socket.join(room);
    socket.data.trackingRoom = room;

    const liveState = activeTracking.get(bookingId);
    socket.emit('tracking:state', {
      bookingId,
      active: !!liveState,
      workerId: liveState?.workerId || booking.workerId,
      customerId: liveState?.customerId || booking.customerId,
      lastLocation: liveState?.lastLocation || null,
      startedAt: liveState?.startedAt || null,
      message: liveState ? 'Tracking is active.' : 'Tracking has not started for this booking yet.'
    });
  });

  socket.on('tracking:start', async ({ bookingId } = {}) => {
    const { authorized, reason, booking } = await verifyBookingTrackingAccess({
      bookingId,
      userId: socket.user?.id,
      role: socket.user?.role
    });

    if (!authorized) {
      socket.emit('tracking:error', { bookingId, message: reason });
      return;
    }

    if (socket.user.role !== 'Worker') {
      socket.emit('tracking:error', { bookingId, message: 'Only the assigned worker can start tracking' });
      return;
    }

    const room = bookingTrackingRoom(bookingId);
    socket.join(room);
    socket.data.trackingRoom = room;

    activeTracking.set(bookingId, {
      bookingId,
      workerId: socket.user.id,
      customerId: booking.customerId,
      startedAt: new Date().toISOString(),
      lastLocation: null,
      status: 'ACTIVE'
    });

    io.to(room).emit('tracking:state', {
      bookingId,
      active: true,
      workerId: socket.user.id,
      customerId: booking.customerId,
      startedAt: activeTracking.get(bookingId).startedAt,
      lastLocation: null,
      message: 'Worker started tracking.'
    });
  });

  socket.on('tracking:update', async ({ bookingId, latitude, longitude, accuracy, timestamp } = {}) => {
    const { authorized, reason, booking } = await verifyBookingTrackingAccess({
      bookingId,
      userId: socket.user?.id,
      role: socket.user?.role
    });

    if (!authorized) {
      socket.emit('tracking:error', { bookingId, message: reason });
      return;
    }

    if (socket.user.role !== 'Worker') {
      socket.emit('tracking:error', { bookingId, message: 'Only the assigned worker can send location updates' });
      return;
    }

    const trackingState = activeTracking.get(bookingId);
    if (!trackingState || trackingState.workerId !== socket.user.id) {
      socket.emit('tracking:error', { bookingId, message: 'No active tracking session for this booking' });
      return;
    }

    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!isValidCoordinate(lat, -90, 90) || !isValidCoordinate(lng, -180, 180)) {
      socket.emit('tracking:error', { bookingId, message: 'Valid latitude and longitude are required' });
      return;
    }

    const persisted = await persistWorkerLocation({
      bookingId,
      workerId: socket.user.id,
      latitude: lat,
      longitude: lng
    });

    trackingState.lastLocation = {
      latitude: lat,
      longitude: lng,
      accuracy: Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
      timestamp: timestamp || new Date().toISOString()
    };
    trackingState.lastUpdated = new Date().toISOString();
    trackingState.lastPersistedToDb = persisted ? new Date().toISOString() : trackingState.lastPersistedToDb || null;

    io.to(bookingTrackingRoom(bookingId)).emit('tracking:location', {
      bookingId,
      workerId: socket.user.id,
      customerId: booking.customerId,
      location: trackingState.lastLocation,
      lastUpdated: trackingState.lastUpdated,
      status: trackingState.status,
      persistedToDb: persisted
    });
  });

  socket.on('tracking:stop', async ({ bookingId } = {}) => {
    const { authorized, reason, booking } = await verifyBookingTrackingAccess({
      bookingId,
      userId: socket.user?.id,
      role: socket.user?.role
    });

    if (!authorized) {
      socket.emit('tracking:error', { bookingId, message: reason });
      return;
    }

    if (socket.user.role !== 'Worker') {
      socket.emit('tracking:error', { bookingId, message: 'Only the assigned worker may stop tracking' });
      return;
    }

    const room = bookingTrackingRoom(bookingId);
    const trackingState = activeTracking.get(bookingId);
    if (!trackingState || trackingState.workerId !== socket.user.id) {
      socket.emit('tracking:error', { bookingId, message: 'No active tracking session to stop' });
      return;
    }

    activeTracking.delete(bookingId);
    io.to(room).emit('tracking:stopped', {
      bookingId,
      workerId: socket.user.id,
      customerId: booking.customerId,
      message: 'Worker stopped sharing live location.'
    });
  });

  socket.on('disconnect', () => {
    const room = socket.data.trackingRoom;
    if (!room || socket.user?.role !== 'Worker') {
      console.log(`[Socket] User disconnected: ${socket.id}`);
      return;
    }

    const bookingId = room.replace('booking:', '');
    const trackingState = activeTracking.get(bookingId);
    if (trackingState && trackingState.workerId === socket.user.id) {
      activeTracking.delete(bookingId);
      io.to(room).emit('tracking:stopped', {
        bookingId,
        workerId: socket.user.id,
        message: 'Worker disconnected and stopped live location sharing.'
      });
    }

    console.log(`[Socket] Worker disconnected from tracking room: ${room}`);
  });
});

// API Status Route
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'LocalHire API is running live' });
});

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/applications', appRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/escrow', escrowRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/notifications', notificationRoutes);

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();
  } catch (dbErr) {
    console.warn(`[Server] Legacy database connection notice: ${dbErr.message}`);
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] Port ${PORT} is already in use. Stop the stale process and try again.`);
      console.error('[Server] Example: Get-NetTCPConnection -LocalPort 5000 | Stop-Process -Id $_.OwningProcess -Force');
      process.exit(1);
    }

    console.error('[Server] Unhandled server error:', err);
    process.exit(1);
  });

  server.listen(PORT, () => {
    console.log(`[Server] LocalHire API server running on port ${PORT}`);
  });
};

if (require.main === module) {
  startServer();
}

module.exports = {
  activeTracking,
  bookingTrackingRoom,
  mapRole,
  verifyBookingTrackingAccess
};
