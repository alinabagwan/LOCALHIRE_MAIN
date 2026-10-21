const prisma = require('../config/prisma');

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const haversineDistanceKm = (fromLat, fromLng, toLat, toLng) => {
  if (fromLat == null || fromLng == null || toLat == null || toLng == null) return Number.MAX_SAFE_INTEGER;

  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const slugify = (value) => String(value || 'other')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'other';

const ensureCategory = async (categoryName) => {
  const name = String(categoryName || 'Other').trim() || 'Other';
  let category = await prisma.serviceCategory.findFirst({
    where: {
      OR: [
        { name },
        { slug: slugify(name) }
      ]
    }
  });

  if (!category) {
    category = await prisma.serviceCategory.create({
      data: {
        name,
        slug: slugify(name),
        description: `Auto-created category for ${name}`
      }
    });
  }

  return category;
};

const formatWorker = (user) => {
  const profile = user.workerProfile;
  const categoryName = profile?.primaryCategory?.name || 'General';
  const skills = (profile?.skills || []).map((skill) => skill.skillName).filter(Boolean);
  const availabilityLabel = profile?.availabilities?.length
    ? 'Available Today'
    : 'Available Today';

  return {
    id: user.id,
    _id: user.id,
    name: user.name,
    email: user.email,
    role: 'Worker',
    avatarUrl: user.avatarUrl,
    phone: user.phone,
    category: categoryName,
    subCategory: profile?.primaryCategory?.name || '',
    hourlyRate: toNumber(profile?.hourlyRate),
    rating: toNumber(profile?.rating),
    reviewsCount: Number(profile?.reviewsCount || 0),
    completedJobsCount: Number(profile?.completedJobsCount || 0),
    bio: profile?.bio || '',
    skills,
    experience: `${Number(profile?.experienceYears || 0)} years`,
    experienceYears: Number(profile?.experienceYears || 0),
    businessName: profile?.businessName || '',
    serviceRadiusKm: Number(profile?.serviceRadiusKm || 20),
    isVerified: profile?.verificationStatus === 'VERIFIED',
    verificationStatus: profile?.verificationStatus,
    availability: availabilityLabel,
    latitude: profile?.latitude ?? null,
    longitude: profile?.longitude ?? null,
    lat: profile?.latitude ?? null,
    lng: profile?.longitude ?? null,
    location: {
      address: profile?.serviceAddress || 'Nearby',
      lat: profile?.latitude ?? null,
      lng: profile?.longitude ?? null,
      radiusKm: profile?.serviceRadiusKm || 20
    },
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
};

// @desc    Get workers with optional search, category & geospatial filters
// @route   GET /api/users/workers
// @access  Public
exports.getWorkers = async (req, res) => {
  try {
    const { q, category, maxPrice, lat, lng, maxDistanceKm } = req.query;
    const maxDistance = Number(maxDistanceKm) || 20;
    const latNum = lat !== undefined && lat !== null && lat !== '' ? Number(lat) : null;
    const lngNum = lng !== undefined && lng !== null && lng !== '' ? Number(lng) : null;
    const maxPriceNum = maxPrice !== undefined && maxPrice !== null && maxPrice !== '' ? Number(maxPrice) : null;

    const workerUsers = await prisma.user.findMany({
      where: {
        role: 'WORKER',
        isActive: true
      },
      include: {
        workerProfile: {
          include: {
            primaryCategory: true,
            skills: true
          }
        }
      }
    });

    const formatted = workerUsers
      .filter((user) => user && user.workerProfile)
      .map((user) => formatWorker(user))
      .filter((worker) => {
        if (category && worker.category !== category) return false;
        if (maxPriceNum !== null && worker.hourlyRate > maxPriceNum) return false;

        if (q) {
          const qLower = q.toLowerCase();
          const haystacks = [
            worker.name || '',
            worker.category || '',
            ...(worker.skills || []),
            worker.bio || ''
          ].map((value) => String(value).toLowerCase());

          if (!haystacks.some((value) => value.includes(qLower))) {
            return false;
          }
        }

        if (latNum !== null && lngNum !== null) {
          const workerLat = worker.latitude ?? null;
          const workerLng = worker.longitude ?? null;

          if (workerLat === null || workerLng === null) {
            return false;
          }

          const distanceKm = haversineDistanceKm(latNum, lngNum, workerLat, workerLng);
          if (distanceKm > maxDistance) {
            return false;
          }
        }

        return true;
      });

    res.json({ success: true, count: formatted.length, workers: formatted });
  } catch (error) {
    console.error('[User Controller] getWorkers error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving workers', error: error.message });
  }
};

// @desc    Get worker by ID
// @route   GET /api/users/workers/:id
// @access  Public
exports.getWorkerById = async (req, res) => {
  try {
    const rawId = req.params.id;
    let worker = null;

    try {
      worker = await prisma.user.findUnique({
        where: { id: rawId },
        include: {
          workerProfile: {
            include: {
              primaryCategory: true,
              skills: true
            }
          }
        }
      });
    } catch (e) {
      // Invalid UUID format or lookup exception
      worker = null;
    }

    // Fallback for legacy mock IDs (w1, w2, w3, etc.)
    if (!worker || worker.role !== 'WORKER') {
      const mockEmailMap = {
        w1: 'electrician@localhire.dev',
        w2: 'electrician@localhire.dev',
        w3: 'cleaner@localhire.dev',
        w4: 'plumber@localhire.dev',
        w5: 'driver@localhire.dev',
        w6: 'freelancer@localhire.dev',
        w7: 'electrician@localhire.dev'
      };
      const fallbackEmail = mockEmailMap[rawId];
      if (fallbackEmail) {
        worker = await prisma.user.findFirst({
          where: { email: fallbackEmail, role: 'WORKER' },
          include: {
            workerProfile: {
              include: {
                primaryCategory: true,
                skills: true
              }
            }
          }
        });
      }
      if (!worker && typeof rawId === 'string' && rawId.startsWith('w')) {
        worker = await prisma.user.findFirst({
          where: { role: 'WORKER' },
          include: {
            workerProfile: {
              include: {
                primaryCategory: true,
                skills: true
              }
            }
          }
        });
      }
    }

    if (!worker || worker.role !== 'WORKER') {
      return res.status(404).json({ success: false, message: 'Worker profile not found' });
    }

    res.json({ success: true, worker: formatWorker(worker) });
  } catch (error) {
    console.error('[User Controller] getWorkerById error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving worker profile', error: error.message });
  }
};

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
exports.updateProfile = async (req, res) => {
  try {
    const forbiddenRoleFields = ['role', 'roles', 'privileges', 'permissions', 'isAdmin', 'admin'];
    const attemptedForbiddenField = forbiddenRoleFields.find((field) => Object.prototype.hasOwnProperty.call(req.body, field));

    if (attemptedForbiddenField) {
      return res.status(400).json({
        success: false,
        message: 'Role and privilege updates are not allowed through the profile endpoint.'
      });
    }

    const { category, hourlyRate, experience, phone, skills, bio, availability, lat, lng, location, name } = req.body;
    // NOTE: 'rating' and 'reviewsCount' are intentionally excluded — they are managed only by reviewController.
    const userId = req.user.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { workerProfile: { include: { skills: true } } }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userUpdate = {};
    if (name) userUpdate.name = String(name).trim();
    if (phone) userUpdate.phone = String(phone).trim();

    const profileUpdate = {};
    if (category) {
      const categoryRecord = await ensureCategory(category);
      profileUpdate.primaryCategoryId = categoryRecord.id;
    }
    if (hourlyRate !== undefined) profileUpdate.hourlyRate = Number(hourlyRate);
    if (bio !== undefined) profileUpdate.bio = String(bio).trim();
    if (experience !== undefined) {
      const match = String(experience).match(/\d+/);
      profileUpdate.experienceYears = match ? Number(match[0]) : 0;
    }
    if (lat !== undefined || lng !== undefined) {
      profileUpdate.latitude = lat === null || lat === '' || lat === undefined ? null : Number(lat);
      profileUpdate.longitude = lng === null || lng === '' || lng === undefined ? null : Number(lng);
    }
    if (location !== undefined) {
      profileUpdate.serviceAddress = typeof location === 'string' ? location : (location?.address || location || 'Nearby');
    }
    if (availability !== undefined) {
      profileUpdate.serviceAddress = profileUpdate.serviceAddress || String(availability).trim();
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...userUpdate,
        ...(user.workerProfile
          ? {
              workerProfile: {
                update: profileUpdate
              }
            }
          : {
              workerProfile: {
                create: {
                  ...profileUpdate,
                  primaryCategoryId: profileUpdate.primaryCategoryId || (await ensureCategory('Other')).id,
                  businessName: user.name,
                  verificationStatus: 'UNVERIFIED'
                }
              }
            })
      },
      include: {
        workerProfile: {
          include: {
            primaryCategory: true,
            skills: true
          }
        }
      }
    });

    if (Array.isArray(skills)) {
      const normalized = [...new Set(skills.map((skill) => String(skill).trim()).filter(Boolean))];
      const profileId = updatedUser.workerProfile?.id;
      if (profileId) {
        await prisma.professionalSkill.deleteMany({ where: { workerProfileId: profileId } });
        if (normalized.length > 0) {
          await prisma.professionalSkill.createMany({
            data: normalized.map((skillName) => ({ workerProfileId: profileId, skillName }))
          });
        }
      }
    }

    const refreshedUser = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        workerProfile: {
          include: {
            primaryCategory: true,
            skills: true
          }
        }
      }
    });

    const responseUser = refreshedUser && refreshedUser.workerProfile ? formatWorker(refreshedUser) : {
      id: refreshedUser.id,
      _id: refreshedUser.id,
      name: refreshedUser.name,
      email: refreshedUser.email,
      role: refreshedUser.role === 'WORKER' ? 'Worker' : refreshedUser.role === 'ADMIN' ? 'Admin' : 'Customer',
      avatarUrl: refreshedUser.avatarUrl,
      phone: refreshedUser.phone,
      createdAt: refreshedUser.createdAt,
      updatedAt: refreshedUser.updatedAt
    };

    res.json({ success: true, user: responseUser });
  } catch (error) {
    console.error('[User Controller] updateProfile error:', error);
    res.status(500).json({ success: false, message: 'Server error updating profile', error: error.message });
  }
};
