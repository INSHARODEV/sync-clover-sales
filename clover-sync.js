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
