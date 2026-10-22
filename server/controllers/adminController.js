const prisma = require('../config/prisma');

// @desc    Get system-wide governance metrics
// @route   GET /api/admin/metrics
// @access  Private (Admin)
exports.getMetrics = async (req, res) => {
  try {
    const [
      totalUsers,
      totalWorkers,
      totalCustomers,
      totalJobs,
      activeJobs,
      completedJobs,
      totalApplications
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: 'WORKER' } }),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.jobPost.count(),
      prisma.jobPost.count({ where: { status: { in: ['OPEN', 'QUOTED', 'ASSIGNED', 'IN_PROGRESS'] } } }),
      prisma.jobPost.count({ where: { status: 'COMPLETED' } }),
      prisma.jobApplication.count()
    ]);

    res.json({
      success: true,
      metrics: {
        totalUsers,
        totalWorkers,
        totalCustomers,
        totalJobs,
        activeJobs,
        completedJobs,
        totalApplications
      }
    });
  } catch (error) {
    console.error('[Admin Controller] getMetrics error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving admin metrics' });
  }
};

// @desc    Get all users for admin listing
// @route   GET /api/admin/users
// @access  Private (Admin)
exports.getAllUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        avatarUrl: true,
        isActive: true,
        isEmailVerified: true,
        createdAt: true,
        updatedAt: true
      }
    });

    res.json({ success: true, count: users.length, users });
  } catch (error) {
    console.error('[Admin Controller] getAllUsers error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving user accounts' });
  }
};

// @desc    Delete a user account
// @route   DELETE /api/admin/users/:id
// @access  Private (Admin)
exports.deleteUser = async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'User account removed successfully' });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    console.error('[Admin Controller] deleteUser error:', error);
    res.status(500).json({ success: false, message: 'Server error removing user' });
  }
};

// @desc    Delete/Moderate a job post
// @route   DELETE /api/admin/jobs/:id
// @access  Private (Admin)
exports.deleteJob = async (req, res) => {
  try {
    await prisma.jobPost.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Job post removed successfully' });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Job post not found' });
    }
    console.error('[Admin Controller] deleteJob error:', error);
    res.status(500).json({ success: false, message: 'Server error moderating job post' });
  }
};

// @desc    Get all platform escrow payments for admin management
// @route   GET /api/admin/escrows
// @access  Private (Admin)
exports.getAllEscrows = async (req, res) => {
  try {
    const escrows = await prisma.escrowPayment.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, email: true, phone: true } },
        worker: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            avatarUrl: true,
            workerProfile: {
              select: {
                licenseNumber: true,
                businessName: true,
                primaryCategory: { select: { name: true } }
              }
            }
          }
        },
        booking: {
          select: {
            id: true,
            bookingNumber: true,
            status: true,
            scheduledAt: true,
            timeSlot: true,
            agreedPrice: true,
            jobPost: { select: { id: true, title: true } }
          }
        }
      }
    });

    res.json({
      success: true,
      count: escrows.length,
      escrows: escrows.map((e) => {
        const workerUpi = e.worker?.workerProfile?.licenseNumber || `${(e.worker?.email || 'worker').split('@')[0]}@okhdfcbank`;
        const payoutAmt = Number(e.workerPayoutAmount || e.totalAmount);
        const upiUri = `upi://pay?pa=${encodeURIComponent(workerUpi)}&pn=${encodeURIComponent(e.worker?.name || 'Worker')}&am=${payoutAmt.toFixed(2)}&cu=INR&tn=${encodeURIComponent('LocalHire Escrow Payout ' + e.invoiceNumber)}`;
        const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiUri)}`;

        return {
          id: e.id,
          invoiceNumber: e.invoiceNumber,
          bookingId: e.bookingId,
          bookingNumber: e.booking?.bookingNumber || 'BK-DIRECT',
          jobTitle: e.booking?.jobPost?.title || 'Direct Booking Service',
          customer: e.customer,
          worker: {
            id: e.worker?.id,
            name: e.worker?.name || 'Worker',
            email: e.worker?.email,
            phone: e.worker?.phone,
            avatarUrl: e.worker?.avatarUrl,
            category: e.worker?.workerProfile?.primaryCategory?.name || 'Professional',
            upiId: workerUpi,
            upiUri,
            qrCodeUrl
          },
          subtotalAmount: Number(e.subtotalAmount),
          platformFee: Number(e.platformFee || 0),
          workerPayoutAmount: payoutAmt,
          totalAmount: Number(e.totalAmount),
          currency: e.currency,
          status: e.status,
          paymentMethod: e.paymentMethod,
          heldAt: e.heldAt,
          releasedAt: e.releasedAt,
          refundReason: e.refundReason,
          createdAt: e.createdAt
        };
      })
    });
  } catch (error) {
    console.error('[Admin Controller] getAllEscrows error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving escrow transactions' });
  }
};

// @desc    Admin dispute resolution (Refund to customer or Payout to worker)
// @route   POST /api/admin/escrows/resolve
// @access  Private (Admin)
exports.resolveDispute = async (req, res) => {
  try {
    const { escrowId, action, reason } = req.body;
    if (!escrowId || !['PAYOUT_WORKER', 'REFUND_CUSTOMER'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Valid escrowId and action (PAYOUT_WORKER or REFUND_CUSTOMER) are required' });
    }

    const payment = await prisma.escrowPayment.findUnique({
      where: { id: escrowId },
      include: { booking: true }
    });

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Escrow payment not found' });
    }

    const nextStatus = action === 'PAYOUT_WORKER' ? 'RELEASED_TO_WORKER' : 'REFUNDED_TO_CUSTOMER';
    const nextBookingStatus = action === 'PAYOUT_WORKER' ? 'COMPLETED' : 'CANCELLED';

    const result = await prisma.$transaction(async (tx) => {
      const updatedPayment = await tx.escrowPayment.update({
        where: { id: escrowId },
        data: {
          status: nextStatus,
          ...(action === 'PAYOUT_WORKER' ? { releasedAt: new Date() } : { refundedAt: new Date() }),
          refundReason: reason ? String(reason).trim() : `Admin resolution: ${action}`
        }
      });

      if (payment.bookingId) {
        await tx.booking.update({
          where: { id: payment.bookingId },
          data: {
            status: nextBookingStatus,
            statusHistory: {
              create: {
                fromStatus: payment.booking?.status || 'DISPUTED',
                toStatus: nextBookingStatus,
                changedById: req.user.id,
                reason: `Admin dispute resolution: ${action} - ${reason || 'Decision applied by admin'}`
              }
            }
          }
        });
      }

      return updatedPayment;
    });

    res.json({
      success: true,
      message: `Dispute resolved successfully: ${action === 'PAYOUT_WORKER' ? 'Payout released to worker' : 'Refund issued to customer'}`,
      payment: result
    });
  } catch (error) {
    console.error('[Admin Controller] resolveDispute error:', error);
    res.status(500).json({ success: false, message: 'Server error resolving dispute' });
  }
};
