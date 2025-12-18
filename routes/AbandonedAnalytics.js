const express = require("express");
const router = express.Router();
const AbandonedCheckout = require("../models/AbandonedCheckout");
const cache = new Map();


function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}


function setCache(key, data, ttl = 60000) {
  cache.set(key, { data, expiry: Date.now() + ttl });
}




function getDateRange(start, end) {
  return {
    s: new Date(`${start}T00:00:00.000Z`),
    e: new Date(`${end}T23:59:59.999Z`)
  };
}


const normalizePhone = (field) => ({
  $let: {
    vars: {
      cleaned: {
        $replaceAll: {
          input: {
            $replaceAll: {
              input: {
                $replaceAll: {
                  input: {
                    $replaceAll: {
                      input: { $ifNull: [field, ""] },
                      find: "+",
                      replacement: ""
                    }
                  },
                  find: " ",
                  replacement: ""
                }
              },
              find: "-",
              replacement: ""
            }
          },
          find: "(",
          replacement: ""
        }
      }
    },
    in: {
      $cond: [
        { $gte: [{ $strLenBytes: "$$cleaned" }, 10] },
        {
          $substrBytes: [
            "$$cleaned",
            { $subtract: [{ $strLenBytes: "$$cleaned" }, 10] },
            10
          ]
        },
        "$$cleaned"
      ]
    }
  }
});


router.get("/summary", async (req, res) => {
  try {
    const { start, end } = req.query;
    function normalizeDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}


const cacheKey = `aband_${normalizeDate(start)}_${normalizeDate(end)}`;


    const cached = getCache(cacheKey);
   if (cached) {
  console.log("🟢 CACHE HIT", cacheKey);
  return res.json(cached);
}
console.log("🔴 CACHE MISS", cacheKey);


    const { s, e } = getDateRange(start, end);


    const pipeline = [
      // 🔥 EARLY FILTER
      {
        $match: {
          eventAt: { $gte: s, $lte: e },
          "assignedExpert.fullName": { $nin: [null, "", "Unassigned"] }
        }
      },


 
      {
        $addFields: {
          normalizedPhone: normalizePhone("$customer.phone")
        }
      },
      { $match: { normalizedPhone: { $ne: "" } } },




      {
        $lookup: {
          from: "leads",
          let: { phone: "$normalizedPhone" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [normalizePhone("$contactNumber"), "$$phone"]
                }
              }
            },
            {
              $project: {
                salesStatusLower: { $toLower: "$salesStatus" },
                healthExpertAssigned: 1
              }
            }
          ],
          as: "leadMatch"
        }
      },


      {
        $lookup: {
          from: "customers",
          let: { phone: "$normalizedPhone" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [normalizePhone("$phone"), "$$phone"]
                }
              }
            },
            {
              $project: {
                leadStatusLower: { $toLower: "$leadStatus" },
                healthExpertAssigned: 1
              }
            }
          ],
          as: "customerMatch"
        }
      },


  
      {
        $addFields: {
          isConverted: {
            $or: [
              {
                $gt: [
                  {
                    $size: {
                      $filter: {
                        input: "$leadMatch",
                        cond: { $eq: ["$$this.salesStatusLower", "sales done"] }
                      }
                    }
                  },
                  0
                ]
              },
              {
                $gt: [
                  {
                    $size: {
                      $filter: {
                        input: "$customerMatch",
                        cond: { $eq: ["$$this.leadStatusLower", "sales done"] }
                      }
                    }
                  },
                  0
                ]
              }
            ]
          }
        }
      },


   
      {
        $facet: {
          daily: [
            {
              $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$eventAt" } },
                totalAbands: { $sum: 1 },
                convertedAbands: { $sum: { $cond: ["$isConverted", 1, 0] } }
              }
            }
          ],


          agents: [
            {
              $group: {
                _id: "$assignedExpert.fullName",
                fullName: { $first: "$assignedExpert.fullName" },
                email: { $first: "$assignedExpert.email" },
                totalAbands: { $sum: 1 },
                convertedAbands: { $sum: { $cond: ["$isConverted", 1, 0] } }
              }
            },
            { $sort: { totalAbands: -1 } }
          ],


          totals: [
            {
              $group: {
                _id: null,
                totalAbands: { $sum: 1 },
                convertedAbands: { $sum: { $cond: ["$isConverted", 1, 0] } }
              }
            }
          ]
        }
      }
    ];


    const [result] = await AbandonedCheckout.aggregate(pipeline, {
      allowDiskUse: true
    });


    const totals = result.totals[0] || {
      totalAbands: 0,
      convertedAbands: 0
    };


    const response = {
      range: { start, end },
      daily: result.daily.map(d => ({
        date: d._id,
        totalAbands: d.totalAbands,
        convertedAbands: d.convertedAbands,
        conversionRate: d.totalAbands
          ? +(d.convertedAbands / d.totalAbands * 100).toFixed(1)
          : 0
      })),
      agents: result.agents.map(a => ({
        expertId: a._id,
        fullName: a.fullName,
        email: a.email,
        totalAbands: a.totalAbands,
        convertedAbands: a.convertedAbands,
        conversionRate: a.totalAbands
          ? +(a.convertedAbands / a.totalAbands * 100).toFixed(1)
          : 0
      })),
      totals: {
        totalAbands: totals.totalAbands,
        convertedAbands: totals.convertedAbands,
        conversionRate: totals.totalAbands
          ? +(totals.convertedAbands / totals.totalAbands * 100).toFixed(1)
          : 0
      }
    };


    setCache(cacheKey, response);
    res.json(response);


  } catch (err) {
    console.error("Abandoned analytics error:", err);
    res.status(500).json({ error: "Aggregation failed" });
  }
});






module.exports = router;



