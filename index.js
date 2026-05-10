import "dotenv/config";
import { continentMap } from "./helpers/continents.js";
import express from "express";
import pg from "pg";
import session from "express-session";



const app = express();

app.set("trust proxy", 1);

const port = process.env.PORT || 3000;

const db = process.env.DATABASE_URL
    ? new pg.Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    })
    : new pg.Client({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: parseInt(process.env.DB_PORT),
    })

if (!process.env.DATABASE_URL) {
    const requireEnv = ["DB_USER", "DB_HOST", "DB_NAME", "DB_PASSWORD", "DB_PORT"];
    for (const key of requireEnv) {
        if (!process.env[key]) {
            console.error(`❌ Missing required environment variable: ${key}`);
            console.error("   Make sure the .env file exists and is completely filled in.");
            process.exit(1);
    }
}
}



db.connect();

app.use(express.urlencoded({ extended: true}));
app.use(express.static("public"));

app.use(session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: 1000 * 60 * 60 *24 * 30, // 30 hari
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
    },
}));

let users = [
    { id: 1, name: "Angela", color: "teal" },
    { id: 2, name: "Farabi", color: "powderblue" },
    { id: 3, name: "Aliza", color: "bisque" }
];

// ambil current_user_id dari session, fallback ke user pertama kalau belum ada
async function getCurrentUserId(req) {
    if (!req.session.current_user_id) {
        // first time visit - set ke user pertama yang ada
        const result = await db.query("SELECT id FROM users ORDER BY id LIMIT 1;");
        if (result.rows.length > 0) {
            req.session.current_user_id = result.rows[0].id;
        }
    }
    return req.session.current_user_id;
}

// helper untuk set
function setCurrentUserId (req, id) {
    req.session.current_user_id = parseInt(id);
}

async function check_visited(req) {
    const current_user_id = await getCurrentUserId(req);
    const result = await db.query(
        `SELECT vc.country_code, vc.visited_at, c.country_name
        FROM visited_countries vc
        JOIN countries c ON c.country_code = vc.country_code
        WHERE vc.user_id = $1
        ORDER BY vc.visited_at DESC;`,
        [current_user_id]
    );
    return result.rows; // [{ country_code, visited_at, country_name }, ...]
}

async function get_current_user(req) {
    const current_user_id = await getCurrentUserId(req);
    const result = await db.query("SELECT * FROM users");
    users = result.rows;
    let current = users.find((user) => user.id == current_user_id);

    // fallback: kalau user tidak ditemukan maka pakai user pertama
    if (!current && users.length > 0) {
        current = users[0];
        current_user_id = current.id;
    }

    return current;
};

async function get_stats(req) {
    const visited = await check_visited(req);

    // hitung total negara di tabel countries (lebih akurat daripada hardcore 195)
    const totalResult = await db.query("SELECT COUNT(*)::int AS total FROM countries;");
    const total_in_world = totalResult.rows[0].total;

    // distribusi per benua
    const continent_counts = {};
    visited.forEach((v) => {
        const continent = continentMap[v.country_code];
        if (continent) {
            continent_counts[continent] = (continent_counts[continent] || 0) + 1;
        }
    });

    // timeline per bulan (12 bulan terakhir)
    const timeline = {};
    visited.forEach((v) => {
        const date = new Date(v.visited_at);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        timeline[key] = (timeline[key] || 0) + 1;
    });

    const continents_count = Object.keys(continent_counts).length;
    const continent_list = Object.keys(continent_counts);

    const percentage = total_in_world > 0 ? ((visited.length / total_in_world) * 100).toFixed(1): "0.0";

    return {
        total_visited: visited.length,
        total_in_world,
        percentage,
        continents_count,
        continent_list,
        continent_counts,
        timeline,
    };
}

// helper untuk redirect dengan flash message cia query param
function flashRedirect(res, type, message) {
    const params = new URLSearchParams({ flash_type: type, flash_msg: message });
    res.redirect("/?" + params.toString());
}

// api: search country by name (untuk autocomplete)
app.get("/api/countries/search", async (req, res) => {
    const q = (req.query.q || "").trim().toLowerCase();

    // minimal 2 karakter agar tidak return semua negara
    if (q.length < 2) {
        return res.json([]);
    }

    try {
        const result = await db.query(
            `SELECT country_code, country_name
            FROM countries
            WHERE LOWER(country_name) LIKE $1
            ORDER BY 
            CASE WHEN LOWER(country_name) LIKE $2 THEN 0 ELSE 1 END, country_name
            LIMIT 8;`,
            [`%${q}%`, `${q}%`] 
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Search error:", err);
        res.status(500).json([]);
    }
});

app.get("/", async(req, res) => {
    const visited = await check_visited(req);
    const current_user = await get_current_user(req);
    const stats = await get_stats(req);
    const current_user_id = await getCurrentUserId(req);
    res.render("index.ejs", {
        countries: visited.map(v => v.country_code), // array of codes (untuk script lama)
        visited_full: visited, // array of objects lengkap (untuk fitur baru)
        total: visited.length,
        users, color: current_user.color,
        current_user_id, stats,
        flash_type: req.query.flash_type || null,
        flash_msg: req.query.flash_msg || null,
    });
});

// export data user aktif sebagai csv/json
app.get("/export", async (req, res) => {
    const format = (req.query.format || "csv").toLowerCase();
    const current_user_id = await getCurrentUserId(req);
    const current_user = await get_current_user(req);

    try {
        const result = await db.query(
            `SELECT vc.country_code, c.country_name, vc.visited_at
            FROM visited_countries vc
            JOIN countries c ON c.country_code = vc.country_code
            WHERE vc.user_id = $1
            ORDER BY vc.visited_at ASC;`,
            [current_user_id]
        );

        const data = result.rows;
        const safeName = current_user.name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
        const dateStamp = new Date().toISOString().split("T")[0]; // year-month-day
        const filename = `travel-${safeName}-${dateStamp}`;

        if (format === "json") {
            const payload = {
                user: current_user.name,
                color: current_user.color,
                exported_at: new Date().toISOString(),
                visits: data.map(row => ({
                    country_code: row.country_code,
                    country_name: row.country_name,
                    visited_at: row.visited_at,
                })),
            };
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}.json"`);
            return res.send(JSON.stringify(payload, null, 2));
        }

        // the csv default
        const escapeCSV = (val) => {
            if (val === null || val === undefined) return "";
            const str = String(val);
            // kalau ada koma, kutip, atau newline dengan kutip + escape kutip dalam
            if (/[",\n"]/.test(str)) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };

        const header = "country_code,country_name,visited_at";
        const rows = data.map(row => 
            [
                escapeCSV(row.country_code),
                escapeCSV(row.country_name),
                escapeCSV(new Date(row.visited_at).toISOString()),
            ].join(",")
        );

        const csv = [header, ...rows].join("\n");

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
        res.send(csv);

    } catch (err) {
        console.error("Export error:", err);
        res.status(500).send("Export failed");
    }
});

app.post("/add", async (req, res) => {
    const input = req.body["country"];
    const current_user_id = await getCurrentUserId(req);
    const current_user = await get_current_user(req);

    // untuk render halaman dengan pesan error
    const renderWithError = async (errorMsg) => {
        const visited = await check_visited(req);
        const stats = await get_stats(req);
        res.render("index.ejs", {
            countries: visited.map(v => v.country_code),
            visited_full: visited,
            total: visited.length,
            users, color: current_user.color,
            error: errorMsg,
            current_user_id, stats,
            flash_type: null,
            flash_msg: null,
        });
    };

    try {
        const result = await db.query(
            "SELECT country_code FROM countries WHERE LOWER(country_name) LIKE '%' || $1 || '%';",
            [input.toLowerCase()]    
        );

        // country is not found
        if (result.rows.length === 0) {
            return renderWithError("Country was not found, try again.");
        }

        const country_code = result.rows[0].country_code;

        // check for duplicate data
        const existing = await db.query(
            "SELECT 1 FROM visited_countries WHERE country_code = $1 AND user_id = $2;",
            [country_code, current_user_id]  
        );

        if (existing.rows.length > 0) {
            return renderWithError("That country had been added.");
        }

        await db.query(
            "INSERT INTO visited_countries (country_code, user_id, visited_at) VALUES ($1, $2, CURRENT_TIMESTAMP);",
            [country_code, current_user_id] 
        );
        return flashRedirect(res, "success", `${input} successfully added.`);
        res.redirect("/");
    } catch (err) {
        console.log(err);
        return renderWithError("Something went wrong, please try again.")
    }
})

app.post("/user", async(req, res) => {
    if (req.body.add === "new") {
        res.render("new.ejs");
    } else {
        setCurrentUserId(req, req.body.user);
        res.redirect("/");
    }
});

app.post("/new", async(req, res) => {
    const name = req.body.name;
    const color = req.body.color;

    const result = await db.query("INSERT INTO users (name, color) VALUES($1, $2) RETURNING *;", [name, color]);

    setCurrentUserId(req, result.rows[0].id);

    res.redirect("/");
})

// route untuk hapus negara dari list user aktif
app.post("/remove-country", async (req, res) => {
    const country_code = req.body.country_code;
    const current_user_id = await getCurrentUserId(req);
    try {
        await db.query(
            "DELETE FROM visited_countries WHERE country_code = $1 AND user_id = $2;",
            [country_code, current_user_id]  
        );
        return flashRedirect(res, "success", "Country successfully deleted.");
        res.redirect("/");
    } catch (err) {
        console.log(err);
        res.redirect("/");
    }
});

// edit nama dan atau warna user
app.post("/edit-user", async (req, res) => {
    const user_id = parseInt(req.body.user_id);
    const name = req.body.name;
    const color = req.body.color;
    try {
        await db.query("UPDATE users SET name = $1, color = $2 WHERE id = $3;",
            [name, color, user_id]
        );
        return flashRedirect(res, "success", "User successfully updated.");
        res.redirect("/");
    } catch (err) {
        console.log(err);
        res.redirect("/");
    }
});

// route untuk hapus user (beserta semua negara yang dikunjunginya)
app.post("/delete-user", async (req, res) => {
    const user_id = parseInt(req.body.user_id);
    const current_user_id = await getCurrentUserId(req);
    try {
        // safety: jangan hapus user terakhir
        const countResult = await db.query("SELECT COUNT(*)::int AS total FROM users;");
        if (countResult.rows[0].total <= 1) {
            return flashRedirect(res, "error", "Cannot delete the last user.");
            return res.redirect("/");
        }

        // hapus visited_countries dulu (untuk jaga-jaga kalau tidak ada FK CASCADE)
        await db.query("DELETE FROM visited_countries WHERE user_id = $1;", [user_id]);
        await db.query("DELETE FROM users WHERE id = $1;", [user_id]);

        // kalau yang dihapus adalah user aktif, pindah ke user pertama yang tersisa
        if (current_user_id == user_id) {
            const firstUser = await db.query("SELECT id FROM users ORDER BY id LIMIT 1;");
            if (firstUser.rows.length > 0) {
                setCurrentUserId(req, firstUser.rows[0].id);
            }
        }
        return flashRedirect(res, "success", "User successfully deleted.")
        res.redirect("/");
    } catch (err) {
        console.log(err);
        res.redirect("/");
    }
});

app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${port}...`)
})

