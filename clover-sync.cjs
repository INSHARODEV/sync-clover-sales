// clover-sync.js

require("dotenv").config();

let accessToken;
let ordersTruncationPerformed = false;
let lineItemsTruncationPerformed = false;
let itemsTruncationPerformed = false;

const RATE_LIMIT_CONFIG = {
  maxRetries: 7, // Increased retries
  baseDelay: 3000, // Increased base delay
  maxDelay: 600000, // Increased max delay to 10 minutes
  requestDelay: 2000, // Increased delay between requests
  chunkSize: 250, // Reduced chunk size
  connectionTimeout: 120000, // 2 minutes
  socketTimeout: 180000, // 3 minutes
};

// List of merchants
const merchants = [
  {
    merchantID: process.env.PLANO_ID,
    merchantApiKey: process.env.PLANO_API_KEY,
    merchantIDAirtable: process.env.PLANO_AIRTABLE_ID,
  },
  {
    merchantID: process.env.PRATTVILLE_1_ID,
    merchantApiKey: process.env.PRATTVILLE_1_API_KEY,
    merchantIDAirtable: process.env.PRATTVILLE_1_AIRTABLE_ID,
  },
  {
    merchantID: process.env.WETUMPKA_ID,
    merchantApiKey: process.env.WETUMPKA_API_KEY,
    merchantIDAirtable: process.env.WETUMPKA_AIRTABLE_ID,
  },
  {
    merchantID: process.env.Montgomery_ID,
    merchantApiKey: process.env.Montgomery_API_KEY,
    merchantIDAirtable: process.env.Montgomery_AIRTABLE_ID,
  },
  {
    merchantID: process.env.Clanton_ID,
    merchantApiKey: process.env.Clanton_API_KEY,
    merchantIDAirtable: process.env.Clanton_AIRTABLE_ID,
  },
  {
    merchantID: process.env.Prattville_2_ID,
    merchantApiKey: process.env.Prattville_2_API_KEY,
    merchantIDAirtable: process.env.Prattville_2_AIRTABLE_ID,
  },
  {
    merchantID: process.env.WETUMPKA_LLC_ID,
    merchantApiKey: process.env.WETUMPKA_LLC_API_KEY,
    merchantIDAirtable: process.env.WETUMPKA_LLC_AIRTABLE_ID,
  },
];

// Constants for time calculations
const currentTimeTimestamp = Date.now();
const threeMonthsAgoTimestamp = currentTimeTimestamp - 90 * 24 * 60 * 60 * 1000;
const november3rdTimestamp = 1730592000000;
const march9thTimestamp = 1709942400000;

// Helper Functions
const formatTimestampWithOffset = (hours, timestamp) => {
  const timeOffset = hours * 60 * 60 * 1000;
  const date = new Date(timestamp - timeOffset);

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getUTCDate()).padStart(2, "0")} ${String(
    date.getUTCHours()
  ).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(
    date.getUTCSeconds()
  ).padStart(2, "0")}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Enhanced error classification
const classifyError = (error) => {
  const errorMessage = error.message.toLowerCase();

  if (
    errorMessage.includes("exceeding_usr_pln_api_freq_count") ||
    errorMessage.includes("429") ||
    errorMessage.includes("rate limit")
  ) {
    return "RATE_LIMIT";
  }

  if (
    errorMessage.includes("socket") ||
    errorMessage.includes("timeout") ||
    errorMessage.includes("econnreset") ||
    errorMessage.includes("other side closed") ||
    errorMessage.includes("fetch failed")
  ) {
    return "CONNECTION";
  }

  if (
    errorMessage.includes("500") ||
    errorMessage.includes("502") ||
    errorMessage.includes("503") ||
    errorMessage.includes("504")
  ) {
    return "SERVER_ERROR";
  }

  return "OTHER";
};

// Enhanced retry mechanism with better error handling
const retryWithBackoff = async (
  fn,
  maxRetries = RATE_LIMIT_CONFIG.maxRetries,
  context = ""
) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const errorType = classifyError(error);

      console.log(
        `❌ ${context} - Attempt ${attempt}/${maxRetries} failed:`,
        error.message
      );

      // Don't retry on certain errors on final attempt
      if (attempt === maxRetries) {
        console.log(`💀 ${context} - All retry attempts exhausted`);
        throw error;
      }

      // Handle different error types
      let shouldRetry = false;
      let delay = RATE_LIMIT_CONFIG.baseDelay;

      switch (errorType) {
        case "RATE_LIMIT":
          shouldRetry = true;
          delay = Math.min(
            RATE_LIMIT_CONFIG.baseDelay * Math.pow(2, attempt - 1),
            RATE_LIMIT_CONFIG.maxDelay
          );
          console.log(
            `⏳ Rate limit detected. Backing off for ${delay / 1000} seconds...`
          );
          break;

        case "CONNECTION":
        case "SERVER_ERROR":
          shouldRetry = true;
          delay = Math.min(
            RATE_LIMIT_CONFIG.baseDelay * Math.pow(1.5, attempt - 1),
            RATE_LIMIT_CONFIG.maxDelay
          );
          console.log(
            `🔌 Connection/Server error. Retrying in ${delay / 1000} seconds...`
          );
          break;

        default:
          // For unknown errors, try a few times with shorter delays
          if (attempt <= 3) {
            shouldRetry = true;
            delay = RATE_LIMIT_CONFIG.baseDelay;
            console.log(
              `❓ Unknown error. Retrying in ${delay / 1000} seconds...`
            );
          }
      }

      if (!shouldRetry) {
        throw error;
      }

      await sleep(delay);

      // Refresh access token on connection errors after a few attempts
      if (errorType === "CONNECTION" && attempt >= 3) {
        console.log("🔄 Refreshing access token due to connection issues...");
        try {
          accessToken = await getAccessToken();
        } catch (tokenError) {
          console.log(
            "⚠️ Failed to refresh token, continuing with existing token"
          );
        }
      }
    }
  }
};

// Enhanced sendDataInChunks with adaptive chunk sizing
async function sendDataInChunks(data, viewId, type) {
  let chunkSize = RATE_LIMIT_CONFIG.chunkSize;
  let consecutiveFailures = 0;
  const totalChunks = Math.ceil(data.length / chunkSize);

  console.log(
    `📦 Sending ${data.length} ${type} records in ${totalChunks} chunks of ${chunkSize}`
  );

  for (let i = 0; i < data.length; i += chunkSize) {
    const chunkIndex = Math.floor(i / chunkSize) + 1;
    const chunk = data.slice(i, i + chunkSize);

    console.log(
      `📤 Sending chunk ${chunkIndex}/${Math.ceil(data.length / chunkSize)} (${
        chunk.length
      } records)`
    );

    try {
      await retryWithBackoff(
        async () => {
          await sendBulkDataToZoho(chunk, viewId, type);
        },
        RATE_LIMIT_CONFIG.maxRetries,
        `${type} chunk ${chunkIndex}`
      );

      consecutiveFailures = 0;
      console.log(`✅ Chunk ${chunkIndex} completed successfully`);
    } catch (error) {
      consecutiveFailures++;
      console.error(
        `❌ Chunk ${chunkIndex} failed permanently:`,
        error.message
      );

      // Adaptive strategy: reduce chunk size if we're having consistent issues
      if (consecutiveFailures >= 2 && chunkSize > 50) {
        const newChunkSize = Math.max(50, Math.floor(chunkSize * 0.7));
        console.log(
          `📉 Reducing chunk size from ${chunkSize} to ${newChunkSize} due to failures`
        );
        chunkSize = newChunkSize;

        // Recalculate chunks with new size
        const remainingData = data.slice(i);
        return await sendDataInChunks(remainingData, viewId, type);
      }

      // If it's a critical chunk, we might want to continue or fail
      const shouldContinue = await handleChunkFailure(error, chunkIndex, type);
      if (!shouldContinue) {
        throw error;
      }
    }

    // Progressive delay between chunks based on success/failure
    if (i + chunkSize < data.length) {
      const delay =
        consecutiveFailures > 0
          ? RATE_LIMIT_CONFIG.requestDelay * 2
          : RATE_LIMIT_CONFIG.requestDelay;

      console.log(`⏳ Waiting ${delay / 1000} seconds before next chunk...`);
      await sleep(delay);
    }
  }
}

// Handle chunk failures with user-defined strategy
async function handleChunkFailure(error, chunkIndex, type) {
  const errorType = classifyError(error);

  // For certain errors, continue processing other chunks
  if (errorType === "CONNECTION" || errorType === "SERVER_ERROR") {
    console.log(
      `⚠️ Continuing with remaining chunks despite chunk ${chunkIndex} failure`
    );
    return true;
  }

  // For rate limits or unknown errors, stop processing
  console.log(`🛑 Stopping processing due to chunk ${chunkIndex} failure`);
  return false;
}

function getImportType(type) {
  if (type === "items") {
    return itemsTruncationPerformed ? "append" : "truncateadd";
  }
  if (type === "orders") {
    return ordersTruncationPerformed ? "append" : "truncateadd";
  }
  if (type === "lineItems") {
    return lineItemsTruncationPerformed ? "append" : "truncateadd";
  }
  return "truncateadd";
}

const formatAmount = (amount) => (amount ? amount / 100 : 0);

// Fetch Orders from Clover API with better error handling
const fetchOrders = async (merchantID, merchantApiKey, urlType, hours) => {
  let offset = 0;
  let allOrders = [];
  const limit = 500;

  const getUrl = () => {
    if (urlType === "first") {
      return `https://api.clover.com/v3/merchants/${merchantID}/orders?limit=${limit}&offset=${offset}&expand=refunds,employee,customers,lineItems,lineItems.discounts,discounts,payments,payment.cardTransaction&filter=createdTime>=${threeMonthsAgoTimestamp}&filter=createdTime<=${november3rdTimestamp}`;
    } else if (urlType === "second") {
      return `https://api.clover.com/v3/merchants/${merchantID}/orders?limit=${limit}&offset=${offset}&expand=refunds,employee,customers,lineItems,lineItems.discounts,discounts,payments,payment.cardTransaction&filter=createdTime>=${november3rdTimestamp}&filter=createdTime<=${march9thTimestamp}`;
    } else if (urlType === "third") {
      return `https://api.clover.com/v3/merchants/${merchantID}/orders?limit=${limit}&offset=${offset}&expand=refunds,employee,customers,lineItems,lineItems.discounts,discounts,payments,payment.cardTransaction&filter=createdTime>=${march9thTimestamp}&filter=createdTime<=${currentTimeTimestamp}`;
    }
    return "";
  };

  while (true) {
    try {
      const response = await retryWithBackoff(
        async () => {
          const res = await fetch(getUrl(), {
            method: "GET",
            headers: {
              accept: "application/json",
              Authorization: `Bearer ${merchantApiKey}`,
            },
          });

          if (!res.ok) {
            throw new Error(`API request failed with status ${res.status}`);
          }

          return res;
        },
        3,
        `Clover API - ${merchantID} ${urlType}`
      );

      const data = await response.json();
      if (!data?.elements?.length) break;

      const modifiedOrders = data.elements
        .map((order) => ({
          ...order,
          merchantID,
          createdTime: formatTimestampWithOffset(hours, order.createdTime),
          modifiedTime: formatTimestampWithOffset(hours, order.modifiedTime),
          clientCreatedTime: formatTimestampWithOffset(
            hours,
            order.clientCreatedTime
          ),
          total: formatAmount(order.total),
          employeeId: order.employee?.id || null,
          employeeName: order.employee?.name || null,
          customerId: order.customers?.elements?.[0]?.id || null,
        }))
        .map(
          ({ employee, customers, device, ...orderWithoutEmployee }) =>
            orderWithoutEmployee
        );

      allOrders = allOrders.concat(modifiedOrders);
      offset += limit;

      // Small delay between API calls to avoid overwhelming the server
      await sleep(100);
    } catch (error) {
      console.error(
        `❌ Error fetching orders for merchant ${merchantID}:`,
        error.message
      );
      break;
    }
  }

  return allOrders;
};

// Process Orders Data (unchanged)
const processOrdersData = (orders, hours) => {
  const ordersData = [];
  const lineItemsData = [];

  orders.forEach((order) => {
    const {
      lineItems,
      state,
      employeeName,
      paymentState,
      payments,
      refunds,
      merchantID,
      ...orderInfo
    } = order;

    const reward_Name =
      order?.discounts?.elements.length > 0
        ? order?.discounts?.elements?.[0].name || ""
        : "";
    const reward_Amount =
      order?.discounts?.elements.length > 0
        ? order?.discounts?.elements?.[0].amount || ""
        : "";
    const reward_Percentage =
      order?.discounts?.elements.length > 0
        ? order?.discounts?.elements?.[0].percentage || ""
        : "";
    const reward_Name2 =
      order?.discounts?.elements.length > 1
        ? order?.discounts?.elements?.[1].name || ""
        : "";
    const reward_Amount2 =
      order?.discounts?.elements.length > 1
        ? order?.discounts?.elements?.[1].amount || ""
        : "";
    const reward_Percentage2 =
      order?.discounts?.elements.length > 1
        ? order?.discounts?.elements?.[1].percentage || ""
        : "";
    const reward_Name3 =
      order?.discounts?.elements.length > 2
        ? order?.discounts?.elements?.[2].name || ""
        : "";
    const reward_Amount3 =
      order?.discounts?.elements.length > 2
        ? order?.discounts?.elements?.[2].amount || ""
        : "";
    const reward_Percentage3 =
      order?.discounts?.elements.length > 2
        ? order?.discounts?.elements?.[2].percentage || ""
        : "";

    const refundId = refunds?.elements?.[0]?.id || null;
    const refundAmount = formatAmount(refunds?.elements?.[0]?.amount) || null;
    const refundTaxAmount =
      formatAmount(refunds?.elements?.[0]?.taxAmount) || null;

    let taxAmount =
      payments?.elements?.length > 0
        ? payments.elements.reduce(
            (total, element) => total + (element.taxAmount || 0),
            0
          )
        : null;

    if (taxAmount !== null) {
      taxAmount = formatAmount(taxAmount);
    }

    delete orderInfo["discounts"];
    ordersData.push({
      ...orderInfo,
      state,
      employeeName,
      paymentState,
      merchantID,
      refundId,
      refundAmount,
      refundTaxAmount,
      taxAmount,
    });

    if (lineItems?.elements) {
      lineItems.elements.forEach((lineItem, idx) => {
        const createdTime = formatTimestampWithOffset(
          hours,
          lineItem.createdTime
        );
        const orderClientCreatedTime = formatTimestampWithOffset(
          hours,
          lineItem.orderClientCreatedTime
        );

        const isRefunded = lineItem?.refunded;

        const discount = lineItem.discounts?.elements?.[0];
        const discountId = discount?.id || null;
        const discountName = discount?.name || null;
        const discountAmount = discount?.amount || null;
        const discountPercentage = discount?.percentage || null;

        const discount2 = lineItem.discounts?.elements?.[1];
        const discountId2 = discount2?.id || null;
        const discountName2 = discount2?.name || null;
        const discountAmount2 = discount2?.amount || null;
        const discountPercentage2 = discount2?.percentage || null;

        const discount3 = lineItem.discounts?.elements?.[2];
        const discountId3 = discount3?.id || null;
        const discountName3 = discount3?.name || null;
        const discountAmount3 = discount3?.amount || null;
        const discountPercentage3 = discount3?.percentage || null;

        const discounts = lineItem.discounts?.elements || [];
        const discountNameSum = discounts
          .map((d) => d.name)
          .filter((name) => name)
          .join(" ");
        const discountAmountSum = discounts.reduce(
          (sum, d) => sum + (d.amount || 0),
          0
        );

        const discountPercentageSum = discounts.reduce((sum, d) => {
          return sum + (lineItem.price || 0) * (d.percentage || 0);
        }, 0);

        const ItemId = lineItem.item?.id || null;
        const exchangedLineItemId = lineItem.exchangedLineItem?.id || null;

        lineItemsData.push({
          ...lineItem,
          ItemId,
          orderId: order.id,
          refundId,
          exchangedLineItemId,
          merchantID,
          createdTime: createdTime,
          orderClientCreatedTime: orderClientCreatedTime,
          price: formatAmount(lineItem.price),
          discountId,
          discountName,
          discountAmountText: formatAmount(discountAmount),
          discountPercentage,
          discountId2,
          discountName2,
          discountAmountText2: formatAmount(discountAmount2),
          discountPercentage2,
          discountId3,
          discountName3,
          discountAmountText3: formatAmount(discountAmount3),
          discountPercentage3,
          discountNameSum: discountNameSum,
          discountAmountSum: formatAmount(discountAmountSum),
          discountPercentageSum: formatAmount(discountPercentageSum),
          taxAmount,
          refundTaxAmount: isRefunded ? refundTaxAmount : "",
          employeeName,
          state,
          paymentState,
          "rewards.name": reward_Name || "",
          "rewards.amount": idx == 0 ? formatAmount(reward_Amount) || "" : "",
          "rewards.percentage": reward_Percentage || "",
          "rewards.name2": reward_Name2 || "",
          "rewards.amount2": idx == 0 ? formatAmount(reward_Amount2) || "" : "",
          "rewards.percentage2": reward_Percentage2 || "",
          "rewards.name3": reward_Name3 || "",
          "rewards.amount3": idx == 0 ? formatAmount(reward_Amount3) || "" : "",
          "rewards.percentage3": reward_Percentage3 || "",
        });
        delete lineItemsData[lineItemsData.length - 1].discounts;
        delete lineItemsData[lineItemsData.length - 1].orderRef;
        delete lineItemsData[lineItemsData.length - 1].item;
        delete lineItemsData[lineItemsData.length - 1].exchangedLineItem;
      });
    }
  });

  return { ordersData, lineItemsData };
};

// Main Function to Sync Clover Orders
const syncCloverToJSON = async () => {
  try {
    console.log("🔄 Starting sync process...");
    accessToken = await getAccessToken();

    const allItemsArrays = await Promise.all(
      merchants.map((m) => fetchAllItems(m.merchantID, m.merchantApiKey))
    );
    const allItems = allItemsArrays.flat();
    console.log(`📦 Found ${allItems.length} items total`);

    if (allItems.length > 0) {
      await sendDataInChunks(allItems, "2972852000000458053", "items");
      console.log("✅ Items sync completed");
    }

    let allOrdersData = [];
    let allLineItemsData = [];

    const processMerchantOrders = async (urlType, hours) => {
      for (const merchant of merchants) {
        try {
          console.log(
            `🏪 Processing ${urlType} orders for merchant: ${merchant.merchantID}`
          );
          const orders = await fetchOrders(
            merchant.merchantID,
            merchant.merchantApiKey,
            urlType,
            hours
          );
          const { ordersData, lineItemsData } = processOrdersData(
            orders,
            hours
          );
          allOrdersData = allOrdersData.concat(ordersData);
          allLineItemsData = allLineItemsData.concat(lineItemsData);
          console.log(
            `✅ Processed ${orders.length} orders for merchant ${merchant.merchantID}`
          );
        } catch (error) {
          console.error(
            `❌ Error processing orders for merchant ${merchant.merchantID}:`,
            error.message
          );
        }
      }
    };

    await processMerchantOrders("first", 5);
    await processMerchantOrders("second", 6);
    await processMerchantOrders("third", 5);

    console.log(`📊 Total orders: ${allOrdersData.length}`);
    console.log(`📊 Total line items: ${allLineItemsData.length}`);

    if (allOrdersData.length > 0) {
      await sendDataInChunks(allOrdersData, "2972852000000094331", "orders");
    }
    if (allLineItemsData.length > 0) {
      await sendDataInChunks(
        allLineItemsData,
        "2972852000000094053",
        "lineItems"
      );
    }

    console.log("✅ Sync completed successfully!");
  } catch (error) {
    console.error("❌ Sync failed:", error.message);
    console.error("Stack trace:", error.stack);
    process.exit(1);
  }
};

const fetchAllItems = async (merchantID, merchantApiKey) => {
  const limit = 500;
  let offset = 0;
  let allItems = [];

  while (true) {
    try {
      const url = `https://api.clover.com/v3/merchants/${merchantID}/items?limit=${limit}&offset=${offset}&expand=categories`;

      const response = await retryWithBackoff(
        async () => {
          const res = await fetch(url, {
            method: "GET",
            headers: {
              accept: "application/json",
              Authorization: `Bearer ${merchantApiKey}`,
            },
          });

          if (!res.ok) {
            throw new Error(`API request failed with status ${res.status}`);
          }

          return res;
        },
        3,
        `Items API - ${merchantID}`
      );

      const data = await response.json();
      if (!data?.elements?.length) break;

      const itemsWithMerchantID = data.elements.map((item) => {
        const firstCategoryName =
          item.categories?.elements?.length > 0
            ? item.categories.elements[0].name
            : null;

        const { categories, ...itemWithoutCategories } = item;

        return {
          ...itemWithoutCategories,
          modifiedTime: formatTimestampWithOffset(0, item.modifiedTime),
          price: formatAmount(item.price),
          cost: formatAmount(item.cost),
          categoryName: firstCategoryName,
          merchantID,
        };
      });

      allItems = allItems.concat(itemsWithMerchantID);
      offset += limit;

      // Small delay between API calls
      await sleep(100);
    } catch (error) {
      console.error(
        `❌ Error fetching items for merchant ${merchantID}:`,
        error.message
      );
      break;
    }
  }

  return allItems;
};

// Enhanced sendBulkDataToZoho with better connection handling
async function sendBulkDataToZoho(data, viewId, type) {
  if (!accessToken) {
    console.error("No access token available. Attempting to get new token...");
    accessToken = await getAccessToken();
  }

  const workspaceId = "2972852000000024001";
  const orgId = "870510719";
  const baseUrl = `https://analyticsapi.zoho.com/restapi/v2/workspaces/${workspaceId}/views/${viewId}/data`;

  const importType = getImportType(type);

  const config = {
    importType: importType,
    fileType: "json",
    autoIdentify: true,
    dateFormat: "yyyy-MM-dd HH:mm:ss",
  };

  const encodedConfig = encodeURIComponent(JSON.stringify(config));
  const urlWithConfig = `${baseUrl}?CONFIG=${encodedConfig}`;

  const boundary =
    "----WebKitFormBoundary" + Math.random().toString(16).substr(2);
  let multipartBody = "";
  multipartBody += `--${boundary}\r\n`;
  multipartBody += `Content-Disposition: form-data; name="DATA"\r\n\r\n`;
  multipartBody += `${JSON.stringify(data)}\r\n`;
  multipartBody += `--${boundary}--\r\n`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log("⏰ Request timeout, aborting...");
      controller.abort();
    }, RATE_LIMIT_CONFIG.connectionTimeout);

    const response = await fetch(urlWithConfig, {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        "ZANALYTICS-ORGID": orgId,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        Connection: "keep-alive",
      },
      body: multipartBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to import bulk data: ${response.status} - ${response.statusText} - ${errorText}`
      );
    }

    const result = await response.json();
    console.log(
      `✅ Bulk data imported successfully for ${type}:`,
      result.summary || "Success"
    );

    if (type === "items") itemsTruncationPerformed = true;
    if (type === "orders") ordersTruncationPerformed = true;
    if (type === "lineItems") lineItemsTruncationPerformed = true;
  } catch (error) {
    // Enhanced error logging
    if (error.name === "AbortError") {
      throw new Error(
        `Request timeout after ${
          RATE_LIMIT_CONFIG.connectionTimeout / 1000
        }s for ${type}`
      );
    }

    console.error(`❌ Error details for ${type}:`);
    console.error(`   Message: ${error.message}`);
    console.error(`   Type: ${error.name}`);
    console.error(`   Code: ${error.code}`);

    throw error;
  }
}

async function getAccessToken() {
  const url = "https://accounts.zoho.com/oauth/v2/token";
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  try {
    const response = await fetch(`${url}?${params.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to get access token: HTTP ${response.status} - ${response.statusText} - ${errorText}`
      );
    }

    const data = await response.json();
    console.log("✅ Successfully obtained Zoho access token");
    return data.access_token;
  } catch (error) {
    console.error("❌ Error fetching access token:", error.message);
    throw error;
  }
}

// Start the sync process
syncCloverToJSON();
