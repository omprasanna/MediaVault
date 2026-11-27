const Batch = require('../models/Batch');
const Job = require('../models/Job');

/**
 * Reconciles a batch rollup document from its remaining child jobs using
 * an atomic version claim (`rollupVersion`) and a single aggregation pass so
 * stale concurrent updates across API and worker processes cannot win.
 */
async function updateBatchRollup(batchId) {
  if (!batchId) return null;

  const claimed = await Batch.findOneAndUpdate(
    { batchId },
    { $inc: { rollupVersion: 1 } },
    { new: true }
  );
  if (!claimed) return null;

  const expectedVersion = claimed.rollupVersion;

  const [counts] = await Job.aggregate([
    { $match: { batchId } },
    {
      $group: {
        _id: null,
        totalItems: { $sum: 1 },
        completedItems: {
          $sum: {
            $cond: [{ $in: ['$status', ['ready', 'expired']] }, 1, 0],
          },
        },
        failedItems: {
          $sum: {
            $cond: [{ $in: ['$status', ['failed', 'cancelled']] }, 1, 0],
          },
        },
      },
    },
  ]);

  const totalItems = counts?.totalItems || 0;
  const completedItems = counts?.completedItems || 0;
  const failedItems = counts?.failedItems || 0;

  if (totalItems === 0) {
    const deleteRes = await Batch.deleteOne({
      _id: claimed._id,
      rollupVersion: expectedVersion,
    });
    if ((deleteRes?.deletedCount || 0) === 0) {
      return { deleted: false, superseded: true };
    }
    return { deleted: true };
  }

  let status = 'processing';
  if (completedItems + failedItems >= totalItems) {
    if (failedItems === 0) {
      status = 'completed';
    } else if (completedItems === 0) {
      status = 'failed';
    } else {
      status = 'partial_failure';
    }
  }

  const updateRes = await Batch.updateOne(
    { _id: claimed._id, rollupVersion: expectedVersion },
    { $set: { totalItems, completedItems, failedItems, status } }
  );

  if ((updateRes?.matchedCount ?? updateRes?.modifiedCount ?? 0) === 0) {
    return { deleted: false, superseded: true };
  }

  return {
    deleted: false,
    batch: {
      batchId: claimed.batchId,
      totalItems,
      completedItems,
      failedItems,
      status,
    },
  };
}

module.exports = {
  updateBatchRollup,
};
