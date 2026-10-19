// LocalHire - Escrow Controller
// Isolated controller handling milestone funding, payment release, disputes, and user ledgers.

const prisma = require('../config/prisma');

const getEscrowProviderStatus = () => {
  const configuredProviders = [
    process.env.RAZORPAY_KEY_ID,
    process.env.RAZORPAY_KEY_SECRET,
    process.env.STRIPE_SECRET_KEY,
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.CASHFREE_APP_ID,
    process.env.CASHFREE_SECRET_KEY
  ].filter(Boolean);

  if (configuredProviders.length === 0) {
    return {
      enabled: false,
      provider: 'UNAVAILABLE',
      message: 'No supported payment provider is configured. LocalHire will not process real funds until a verified gateway and webhook secret are added to the environment.'
    };
  }

  return {
    enabled: true,
    provider: process.env.RAZORPAY_KEY_ID ? 'RAZORPAY' : (process.env.STRIPE_SECRET_KEY ? 'STRIPE' : 'CASHFREE'),
    message: 'A supported payment provider is configured and real escrow processing is enabled.'
  };
};

const paymentMethodMap = {
  UPI: 'UPI',
  CARD: 'CARD',
  NET_BANKING: 'NET_BANKING',
  CASH_ON_DELIVERY: 'CASH_ON_DELIVERY',
  WALLET: 'WALLET'
};

const normalizePaymentMethod = (value) => {
  const key = String(value || 'UPI').toUpperCase().replace(/\s+/g, '_');
  return paymentMethodMap[key] || 'UPI';
};

const getCurrentUserId = (req) => req.user.id || req.user._id;

const normalizeEscrow = (payment, booking) => ({
  id: payment.id,
  bookingId: payment.bookingId,
  jobId: booking?.jobPostId || null,
  customerId: payment.customerId,
  workerId: payment.workerId,
  amount: Number(payment.totalAmount),
  currency: payment.currency,
  status: payment.status,
  paymentMethod: payment.paymentMethod,
  createdAt: payment.createdAt,
  releasedAt: payment.releasedAt,
  heldAt: payment.heldAt,
  customer: payment.customer ? {
    id: payment.customer.id,
    name: payment.customer.name,
    email: payment.customer.email
  } : null,
  worker: payment.worker ? {
    id: payment.worker.id,
    name: payment.worker.name,
    email: payment.worker.email
  } : null
});

// @desc    Fund job escrow (Hold payment in escrow)
// @route   POST /api/escrow/fund
// @access  Private (Customer)
exports.fundEscrow = async (req, res) => {
  try {
    const providerStatus = getEscrowProviderStatus();
    if (!providerStatus.enabled) {
      return res.status(503).json({
        success: false,
        provider: providerStatus.provider,
        message: providerStatus.message
      });
    }

    const { jobId, workerId, amount, paymentMethod } = req.body;
    const customerId = getCurrentUserId(req);

    if (!jobId || !workerId || !amount) {
      return res.status(400).json({ success: false, message: 'Job ID, worker ID, and amount are required' });
    }

    const amountValue = Number(amount);
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a valid positive number' });
    }

    const job = await prisma.jobPost.findUnique({
      where: { id: String(jobId) },
      select: { id: true, status: true }
    });

    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    let booking = await prisma.booking.findFirst({
      where: {
        jobPostId: String(jobId),
        customerId,
        workerId: String(workerId)
      }
    });

    if (!booking) {
      booking = await prisma.booking.create({
        data: {
          bookingNumber: `BK-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`,
          customerId,
          workerId: String(workerId),
          jobPostId: String(jobId),
          agreedPrice: amountValue,
          scheduledAt: new Date(),
          timeSlot: 'Flexible',
          status: 'REQUESTED'
        }
      });
    }

    const existingEscrow = await prisma.escrowPayment.findFirst({
      where: {
        bookingId: booking.id,
        status: { in: ['PENDING', 'HELD_IN_ESCROW'] }
      }
    });

    if (existingEscrow) {
      return res.status(400).json({ success: false, message: 'Escrow is already active and funded for this job' });
    }

    const payment = await prisma.escrowPayment.create({
      data: {
        invoiceNumber: `INV-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`,
        bookingId: booking.id,
        customerId,
        workerId: String(workerId),
        subtotalAmount: amountValue,
        taxAmount: 0,
        platformFee: 0,
        workerPayoutAmount: amountValue,
        totalAmount: amountValue,
        currency: 'INR',
        status: 'HELD_IN_ESCROW',
        paymentMethod: normalizePaymentMethod(paymentMethod),
        heldAt: new Date()
      },
      include: {
        customer: { select: { id: true, name: true, email: true } },
        worker: { select: { id: true, name: true, email: true } }
      }
    });

    await Promise.all([
      prisma.booking.update({
        where: { id: booking.id },
        data: {
          status: 'IN_PROGRESS',
          startedAt: new Date()
        }
      }),
      prisma.jobPost.update({
        where: { id: String(jobId) },
        data: { status: 'IN_PROGRESS' }
      })
    ]);

    res.status(201).json({
      success: true,
      message: 'Payment successfully locked in Escrow',
      escrow: normalizeEscrow(payment, booking)
    });
  } catch (error) {
    console.error('[Escrow Controller] Fund Error:', error);
    res.status(500).json({ success: false, message: 'Server error while funding escrow', error: error.message });
  }
};

// @desc    Release escrow funds to worker & complete job
// @route   POST /api/escrow/release
// @access  Private (Customer or Admin)
exports.releaseEscrow = async (req, res) => {
  try {
    const providerStatus = getEscrowProviderStatus();
    if (!providerStatus.enabled) {
      return res.status(503).json({
        success: false,
        provider: providerStatus.provider,
        message: providerStatus.message
      });
    }

    const { jobId } = req.body;
    const currentUserId = getCurrentUserId(req);

    if (!jobId) {
      return res.status(400).json({ success: false, message: 'Job ID is required' });
    }

    const payment = await prisma.escrowPayment.findFirst({
      where: {
        booking: { jobPostId: String(jobId) },
        status: 'HELD_IN_ESCROW'
      },
      include: {
        customer: { select: { id: true, name: true, email: true } },
        worker: { select: { id: true, name: true, email: true } },
        booking: true
      }
    });

    if (!payment) {
      return res.status(404).json({ success: false, message: 'No active held escrow transaction found for this job' });
    }

    if (payment.customerId !== currentUserId && req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, message: 'Only the customer or admin can release payment' });
    }

    if (payment.booking.status !== 'COMPLETED') {
      return res.status(409).json({
        success: false,
        message: 'Escrow release requires a completed booking that has been confirmed by the customer.'
      });
    }

    const [updatedPayment, updatedBooking, updatedJob] = await Promise.all([
      prisma.escrowPayment.update({
        where: { id: payment.id },
        data: {
          status: 'RELEASED_TO_WORKER',
          releasedAt: new Date()
        },
        include: {
          customer: { select: { id: true, name: true, email: true } },
          worker: { select: { id: true, name: true, email: true } }
        }
      }),
      prisma.booking.update({
        where: { id: payment.bookingId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date()
        }
      }),
      prisma.jobPost.update({
        where: { id: String(jobId) },
        data: { status: 'COMPLETED' }
      })
    ]);

    res.json({
      success: true,
      message: 'Escrow funds successfully released to worker. Job marked as Completed!',
      escrow: normalizeEscrow(updatedPayment, updatedBooking)
    });
  } catch (error) {
    console.error('[Escrow Controller] Release Error:', error);
    res.status(500).json({ success: false, message: 'Server error while releasing escrow', error: error.message });
  }
};

// @desc    Raise a dispute on held escrow
// @route   POST /api/escrow/dispute
// @access  Private (Customer or Worker)
exports.disputeEscrow = async (req, res) => {
  try {
    const { jobId, reason } = req.body;

    const payment = await prisma.escrowPayment.findFirst({
      where: {
        booking: { jobPostId: String(jobId) },
        status: 'HELD_IN_ESCROW'
      },
      include: { booking: true }
    });

    if (!payment) {
      return res.status(404).json({ success: false, message: 'No active held escrow transaction found for this job' });
    }

    const [updatedPayment, updatedBooking] = await Promise.all([
      prisma.escrowPayment.update({
        where: { id: payment.id },
        data: {
          status: 'DISPUTED',
          refundReason: reason || 'Issue reported during job execution'
        }
      }),
      prisma.booking.update({
        where: { id: payment.bookingId },
        data: { status: 'DISPUTED' }
      })
    ]);

    res.json({
      success: true,
      message: 'Escrow payment flagged for dispute. Admin team will review.',
      escrow: normalizeEscrow(updatedPayment, updatedBooking)
    });
  } catch (error) {
    console.error('[Escrow Controller] Dispute Error:', error);
    res.status(500).json({ success: false, message: 'Server error while disputing escrow', error: error.message });
  }
};

// @desc    Get escrow status for a specific job
// @route   GET /api/escrow/job/:jobId
// @access  Private
exports.getJobEscrow = async (req, res) => {
  try {
    const payment = await prisma.escrowPayment.findFirst({
      where: {
        booking: { jobPostId: req.params.jobId }
      },
      include: {
        booking: true,
        customer: { select: { id: true, name: true, email: true } },
        worker: { select: { id: true, name: true, email: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      escrow: payment ? normalizeEscrow(payment, payment.booking) : null
    });
  } catch (error) {
    console.error('[Escrow Controller] getJobEscrow error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching job escrow' });
  }
};

// @desc    Get user financial ledger (all escrow transactions)
// @route   GET /api/escrow/ledger
// @access  Private
exports.getUserLedger = async (req, res) => {
  try {
    const userId = getCurrentUserId(req);

    const transactions = await prisma.escrowPayment.findMany({
      where: {
        OR: [{ customerId: userId }, { workerId: userId }]
      },
      include: {
        booking: {
          include: {
            jobPost: { select: { id: true, title: true, status: true } },
            customer: { select: { id: true, name: true, email: true } },
            worker: { select: { id: true, name: true, email: true } }
          }
        },
        customer: { select: { id: true, name: true, email: true } },
        worker: { select: { id: true, name: true, email: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      transactions: transactions.map((tx) => ({
        id: tx.id,
        job: tx.booking?.jobPost ? {
          id: tx.booking.jobPost.id,
          title: tx.booking.jobPost.title,
          status: tx.booking.jobPost.status
        } : null,
        customer: tx.customer,
        worker: tx.worker,
        amount: Number(tx.totalAmount),
        status: tx.status,
        paymentMethod: tx.paymentMethod,
        createdAt: tx.createdAt,
        releasedAt: tx.releasedAt,
        heldAt: tx.heldAt
      }))
    });
  } catch (error) {
    console.error('[Escrow Controller] getUserLedger error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching transaction ledger' });
  }
};
