const http = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 32 * 1024;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
}
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const CATEGORIES = new Set([
    "Cardboard",
    "Plastic Bottle",
    "Polythene Bag",
    "Paper",
    "Other / Unknown"
]);

function sendJson(response, statusCode, data) {
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    response.end(JSON.stringify(data));
}

function imageMatchesType(buffer, mimeType) {
    if (mimeType === "image/jpeg") {
        return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    if (mimeType === "image/png") {
        return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    return mimeType === "image/webp"
        && buffer.length >= 12
        && buffer.toString("ascii", 0, 4) === "RIFF"
        && buffer.toString("ascii", 8, 12) === "WEBP";
}

async function readJsonBody(request, response) {
    const declaredLength = Number(request.headers["content-length"] || 0);
    if (declaredLength > MAX_REQUEST_BYTES) {
        sendJson(response, 413, { error: "Image must be 5 MB or smaller." });
        request.resume();
        return null;
    }

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of request) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_REQUEST_BYTES) {
            sendJson(response, 413, { error: "Image must be 5 MB or smaller." });
            request.resume();
            return null;
        }
        chunks.push(chunk);
    }

    try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            sendJson(response, 400, { error: "Request body must be a JSON object." });
            return null;
        }
        return body;
    } catch {
        sendJson(response, 400, { error: "Request body must be valid JSON." });
        return null;
    }
}

async function identifyImage(request, response) {
    if (!request.headers["content-type"]?.startsWith("application/json")) {
        sendJson(response, 415, { error: "Send the image as a JSON request." });
        request.resume();
        return;
    }

    const body = await readJsonBody(request, response);
    if (!body) return;

    const { mimeType, imageBase64 } = body;
    if (!ALLOWED_TYPES.has(mimeType) || typeof imageBase64 !== "string"
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageBase64)) {
        sendJson(response, 400, { error: "Choose a valid JPEG, PNG, or WebP image." });
        return;
    }

    const image = Buffer.from(imageBase64, "base64");
    if (image.length === 0 || image.length > MAX_IMAGE_BYTES) {
        sendJson(response, 413, { error: "Image must be between 1 byte and 5 MB." });
        return;
    }
    if (!imageMatchesType(image, mimeType)) {
        sendJson(response, 400, { error: "The image contents do not match the selected file type." });
        return;
    }

    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey || apiKey === "your_groq_api_key_here") {
        sendJson(response, 503, { error: "Image identification is not configured. Set GROQ_API_KEY on the server." });
        return;
    }

    let groqResponse;
    try {
        groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            signal: AbortSignal.timeout(45000),
            body: JSON.stringify({
                model: "qwen/qwen3.8-27b",
                messages: [{
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Identify the main visible waste item in this image. Choose exactly one category from Cardboard, Plastic Bottle, Polythene Bag, Paper, or Other / Unknown. Only identify an item when it is clearly visible; use Other / Unknown if the image is unclear, contains no waste, or does not clearly match a category. Do not estimate weight, value, or confidence. Return only a JSON object with boolean field identified and string field category."
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimeType};base64,${imageBase64}`
                            }
                        }
                    ]
                }],
                temperature: 0,
                max_completion_tokens: 100,
                response_format: { type: "json_object" }
            })
        });
    } catch (error) {
        console.error("Groq request failed:", error.message);
        sendJson(response, 502, { error: "Image identification could not reach the analysis service. Please try again." });
        return;
    }

    if (!groqResponse.ok) {
        console.error("Groq returned HTTP", groqResponse.status);
        sendJson(response, 502, { error: "Image identification is temporarily unavailable. Please try again." });
        return;
    }

    let result;
    try {
        const completion = await groqResponse.json();
        result = JSON.parse(completion.choices?.[0]?.message?.content || "");
    } catch (error) {
        console.error("Groq returned an unreadable identification response:", error.message);
        sendJson(response, 502, { error: "Image identification returned an invalid response. Please try again." });
        return;
    }

    if (typeof result.identified !== "boolean" || !CATEGORIES.has(result.category)) {
        console.error("Groq response did not match the expected category schema.");
        sendJson(response, 502, { error: "Image identification returned an invalid result. Please try again." });
        return;
    }

    const identified = result.identified && result.category !== "Other / Unknown";
    sendJson(response, 200, {
        identified,
        category: identified ? result.category : "Other / Unknown"
    });
}

const server = http.createServer((request, response) => {
    (async () => {
        const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
        if (request.method === "POST" && requestUrl.pathname === "/api/identify") {
            await identifyImage(request, response);
            return;
        }

        if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html")) {
            try {
                const html = await readFile(path.join(__dirname, "index.html"));
                response.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "X-Content-Type-Options": "nosniff"
                });
                response.end(html);
            } catch (error) {
                console.error("Unable to read the application page:", error.message);
                sendJson(response, 500, { error: "The application page could not be loaded." });
            }
            return;
        }

        sendJson(response, 404, { error: "Not found." });
    })().catch((error) => {
        console.error("Request handling failed:", error.message);
        if (!response.headersSent) {
            sendJson(response, 500, { error: "The request could not be completed." });
        } else {
            response.end();
        }
    });
});

server.listen(PORT, HOST, () => {
    console.log(`Green Link is running at http://${HOST}:${PORT}`);
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey || apiKey === "your_groq_api_key_here") {
        console.warn("GROQ_API_KEY is not set; image identification requests will return 503.");
    }
});

server.on("error", (error) => {
    console.error("Green Link server failed to start:", error.message);
    process.exitCode = 1;
});
