import express from "express";
import pg from "pg";
import bodyParser from "body-parser";
import cors from "cors"; // Allow our React app to communicate with our server
import bcrypt from "bcrypt";
import session from "express-session"; // Allow us to set up session to save user logins
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import P_LocalStrategy from "passport-local";
import jwt from "jsonwebtoken";
import P_JwtStrategy from "passport-jwt";
import multer from "multer";
import dotenv from "dotenv"; // Corrected import for dotenv
import nodemailer from "nodemailer";
import fs from "fs"; // Removed unused import copyFile
import path from "path";
import { pgDump, pgRestore } from "pg-dump-restore"; // Ensure these are needed
import cron from "node-cron";
import { to as copyTo, from as copyFrom } from "pg-copy-streams"; // Ensure these are needed
import { pipeline } from "stream/promises"; // Updated import

// Load environment variables
dotenv.config();

const { Strategy: LocalStrategy } = P_LocalStrategy;
const { Strategy: JwtStrategy, ExtractJwt } = P_JwtStrategy;

const port = process.env.PORT || 5000; // Use PORT environment variable if available
const app = express();

// Used for destructive tasks like deleting all users
const masterKey = process.env.SESSION_MASTER_KEY;
const jwtTokenSecret = process.env.SESSION_JWT_TOKEN_SECRET;
const saltRounds = 10;

// Initialize PostgreSQL session store
const pgSession = connectPgSimple(session);

// All database tables
const allDatabaseTables = [
  "about",
  "categories",
  "customer_testimonial",
  "delivery_details",
  "newsletter",
  "order_item",
  "orders",
  "products",
  "slide_show",
  "users",
];

//nodmailer for gmail
// Setup Nodemailer
/*
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SESSION_EMAIL_SENDER,
    pass: process.env.SESSION_EMAIL_SENDER_PASSWORD,
  },
});
*/

//nodmaile for cpanel
const transporter = nodemailer.createTransport({
  host: "mail.jscollection.co.ke", // SMTP Host
  port: 465, // Use 465 for SSL or 587 for TLS
  secure: true, // true for SSL, false for TLS
  auth: {
    user: process.env.SESSION_EMAIL_SENDER, // Your cPanel email
    pass: process.env.SESSION_EMAIL_SENDER_PASSWORD, // Your cPanel email password
  },
});

// Configure multer for file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "../Client/public/Images/All_Images")); // Use path.join for cross-platform compatibility
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname); // Fixed template string usage
  },
});

// Multer middleware
const upload = multer({ storage });

/*
// Connect to the database using connection pool
const db = new pg.Pool({
  user: process.env.SESSION_DATABASE_USER,
  host: process.env.SESSION_DATABASE_HOST,
  database: process.env.SESSION_DATABASE_NAME,
  password: process.env.SESSION_DATABASE_PASSWORD,
  port: process.env.SESSION_DATABASE_PORT || 5432, // Use environment variable for port if defined
});
*/
const db = new pg.Pool({
  user: process.env.SESSION_DATABASE_USER,
  host: process.env.SESSION_DATABASE_HOST,
  database: process.env.SESSION_DATABASE_NAME,
  password: process.env.SESSION_DATABASE_PASSWORD,
  port: process.env.SESSION_DATABASE_PORT || 5432, // Use environment variable for port if defined
  ssl: {
    rejectUnauthorized: false, // Set to true in production with a valid certificate
  },
});

// Test the database connection
db.connect()
  .then(() => console.log("Connected to the database"))
  .catch((err) => console.error("Database connection error", err));

// Middleware setup for CORS and body parsing
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Session management setup
app.use(
  session({
    store: new pgSession({
      pool: db,
      tableName: "user_sessions", // Table to store sessions in PostgreSQL
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24, // Expire in 1 day
      secure: false, // Set to true if using HTTPS
      httpOnly: true,
      sameSite: "lax",
    },
  })
);

// Initialize Passport.js middleware for authentication
app.use(passport.initialize());
app.use(passport.session());
/*************BACK UP DATABASE **********/
//backUp Directory
const backupDir = path.join(process.cwd(), "back_up");

const backupDatabase = async () => {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir);
  }

  const dbPath = path.join(backupDir, "js_collection.sql");

  try {
    // Execute the pgDump command
    const { stdout, stderr } = await pgDump(
      {
        port: 5432,
        host: process.env.SESSION_DATABASE_HOST,
        database: process.env.SESSION_DATABASE_NAME,
        username: process.env.SESSION_DATABASE_USER,
        password: process.env.SESSION_DATABASE_PASSWORD,
      },
      {
        // Store the dump in memory before writing it to the file
        file: dbPath,
      }
    );

    // Check for any errors during the backup
    if (stderr) {
      console.error("Error during backup:", stderr);
      return stderr;
    }

    // Write the stdout content to the .sql file if no errors
    fs.writeFileSync(dbPath, stdout);
    console.log("Backup successful:", dbPath);
    return dbPath;
  } catch (err) {
    console.error("Error during backup operation:", err);
    return null;
  }
};

app.post("/backup", async (req, res) => {
  try {
    const backUpResponse = await db.query("SELECT * FROM backUps");
    const dateStr = new Date().toLocaleString(); // Format as yyyy-MM-dd-HH-mm-ss
    if (backUpResponse.rows.length > 0) {
      await db.query("UPDATE backUps SET backup_time = $1 WHERE id = $2", [
        dateStr,
        1,
      ]);
    } else {
      await db.query("INSERT INTO backUps (backup_time) VALUES ($1)", [
        dateStr,
      ]);
    }
    console.log("Date and time:", dateStr);
    const dbPath = await backupDatabase();
    res
      .status(200)
      .send({ message: "Database backed up successfully", date: dateStr });
    console.log("Database backed up successfully at:", dbPath);
  } catch (err) {
    console.error("An Error occured when backing up database ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

function backUpQuery(table_name) {
  let query = "";
  let columnsToDisplay = [];
  switch (table_name) {
    case "orders":
      columnsToDisplay = [
        "order_id",
        `${table_name}.user_id`,
        "total",
        "status",
        `to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at`,
        `to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at`,
        "description",
      ];
      break;
    case "order_item":
      columnsToDisplay = [
        `${table_name}.product_id`,
        "quantity",
        `${table_name}.price`,
        `to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at`,
        `to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at`,
        "order_id",
        "total",
        "order_item_id",
      ];
      break;
    case "delivery_details":
      columnsToDisplay = [
        "delivery_id",
        `${table_name}.user_id`,
        `${table_name}.order_id`,
        "email",
        "country",
        "f_name",
        "l_name",
        "address",
        "city",
        "postal_code",
        "phone_number",
        "status",
        `to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at`,
        `to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at`,
        "description",
      ];
      break;
    case "users":
      columnsToDisplay = [
        "user_id",
        "username",
        "email",
        "password",
        "is_disabled",
        `to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at`,
        `to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at`,
        `user_type`,
      ];
      break;
    case "products":
      columnsToDisplay = [
        "product_id",
        "name",
        "description",
        "price",
        "stock",
        "images",
        `${table_name}.is_disabled`,
        `to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at`,
        `to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at`,
        "category_id",
      ];
      break;
    case "categories":
      columnsToDisplay = ["category_id", "category", "is_disabled"];
      break;
    case "about":
      columnsToDisplay = [
        "about_id",
        "our_story",
        "mission",
        "vision",
        "images",
      ];
      break;
    case "customer_testimonial":
      columnsToDisplay = [
        "customer_testimonial_id",
        "name",
        "comment",
        "rating",
        "title",
        "avatar",
      ];
      break;
    case "newsletter":
      columnsToDisplay = ["newsletter_id", "email", "is_disabled"];
      break;
    case "slide_show":
      columnsToDisplay = ["title", "description", "image", "slide_show_id"];
      break;
    default:
      return res.status(400).send({ error: "Invalid table name" });
  }
  query = `COPY (SELECT ${columnsToDisplay.join(
    ", "
  )} FROM public.${table_name}) TO STDOUT WITH CSV HEADER;`;
  return query;
}

function restoreTableQuery(table_name) {
  let query = "";
  let tableID = "";
  switch (table_name) {
    case "orders":
      tableID = "order_id";
      query = `INSERT INTO ${table_name} SELECT * FROM temp_${table_name} ON CONFLICT (${tableID}) 
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        total = EXCLUDED.total,
        status = EXCLUDED.status,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        description = EXCLUDED.description;
        DROP TABLE temp_${table_name};`;
      break;
    case "order_item":
      tableID = "order_item_id";
      query = `INSERT INTO ${table_name} SELECT * FROM temp_${table_name} ON CONFLICT (${tableID}) 
      DO UPDATE SET
        product_id = EXCLUDED.product_id,
        quantity = EXCLUDED.quantity,
        price = EXCLUDED.price,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        order_id = EXCLUDED.order_id,
        total = EXCLUDED.total;
        DROP TABLE temp_${table_name};`;
      break;
    case "delivery_details":
      tableID = "delivery_id";
      query = `INSERT INTO ${table_name} SELECT * FROM temp_${table_name} ON CONFLICT (${tableID}) 
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        order_id = EXCLUDED.order_id,
        email = EXCLUDED.email,
        f_name = EXCLUDED.f_name,
        l_name = EXCLUDED.l_name,
        address = EXCLUDED.address,
        city = EXCLUDED.city,
        postal_code = EXCLUDED.postal_code,
        phone_number = EXCLUDED.phone_number,
        status = EXCLUDED.status,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        description = EXCLUDED.description;
        DROP TABLE temp_${table_name};`;
      break;
    case "users":
      tableID = "user_id";
      query = `INSERT INTO ${table_name} SELECT * FROM temp_${table_name} ON CONFLICT (${tableID}) 
      DO UPDATE SET
        username = EXCLUDED.username,
        email = EXCLUDED.email,
        password = EXCLUDED.password,
        is_disabled = EXCLUDED.is_disabled,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        user_type = EXCLUDED.user_type;
        DROP TABLE temp_${table_name};`;
      break;
    case "products":
      tableID = "product_id";
      query = `INSERT INTO ${table_name} SELECT * FROM temp_${table_name} ON CONFLICT (${tableID}) 
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        price = EXCLUDED.price,
        stock = EXCLUDED.stock,
        images = EXCLUDED.images,
        is_disabled = EXCLUDED.is_disabled,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        category_id = EXCLUDED.category_id;
        DROP TABLE temp_${table_name};`;
      break;
    case "categories":
      tableID = "category_id";
      query = `INSERT INTO ${table_name} SELECT * FROM temp_${table_name} ON CONFLICT (${tableID}) 
      DO UPDATE SET
        category = EXCLUDED.category,
        is_disabled = EXCLUDED.is_disabled;
      DROP TABLE temp_${table_name};`;
      break;
    case "about":
      tableID = "about_id";
      query = `INSERT INTO ${table_name} SELECT * FROM temp_${table_name} ON CONFLICT (${tableID}) 
      DO UPDATE SET
        our_story = EXCLUDED.our_story,
        mission = EXCLUDED.mission,
        vision = EXCLUDED.vision,
        images = EXCLUDED.images;
      DROP TABLE temp_${table_name};`;
      break;
    case "customer_testimonial":
      tableID = "customer_testimonial_id";
      query = `INSERT INTO ${table_name} SELECT * FROM temp_${table_name} ON CONFLICT (${tableID}) 
      DO UPDATE SET
        name = EXCLUDED.name,
        comment = EXCLUDED.comment,
        rating = EXCLUDED.rating,
        title = EXCLUDED.title,
        avatar = EXCLUDED.avatar;
      DROP TABLE temp_${table_name};`;
      break;
    case "newsletter":
      tableID = "newsletter_id";
      query = `INSERT INTO ${table_name} SELECT * FROM temp_${table_name} ON CONFLICT (${tableID}) 
      DO UPDATE SET
        email = EXCLUDED.email,
        is_disabled = EXCLUDED.is_disabled;
      DROP TABLE temp_${table_name};`;
      break;
    case "slide_show":
      tableID = "slide_show_id";
      query = `INSERT INTO ${table_name} SELECT * FROM temp_${table_name} ON CONFLICT (${tableID}) 
      DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        image = EXCLUDED.image;
      DROP TABLE temp_${table_name};`;
      break;
    default:
      return res.status(400).send({ error: "Invalid table name" });
  }
  return query;
}

app.post("/backUpTables", async (req, res) => {
  try {
    // Create directories if they don't exist
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir);
    }
    const tableDir = path.join(backupDir, "table");
    if (!fs.existsSync(tableDir)) {
      fs.mkdirSync(tableDir);
    }

    const client = await db.connect();
    const errors = []; // Collect errors during the process

    try {
      // Process all tables
      await Promise.all(
        allDatabaseTables.map(async (tableName) => {
          try {
            console.log("Backing up table:", tableName);
            // Validate tableName to prevent SQL injection
            if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
              throw new Error("Invalid table name");
            }

            const filePath = path.join(tableDir, `${tableName}.csv`);
            const query = backUpQuery(tableName);
            const stream = client.query(copyTo(query));
            const fileStream = fs.createWriteStream(filePath);

            console.log(`Starting backup of ${tableName} to ${filePath}`);
            await pipeline(stream, fileStream);
            console.log(`Backup of ${tableName} completed successfully`);
          } catch (error) {
            console.error(`Error backing up ${tableName}:`, error);
            errors.push({ table: tableName, error: error.message });
          }
        })
      );

      // Send final response after processing all tables
      if (errors.length > 0) {
        return res.status(500).json({
          message: "Backup completed with errors",
          errors,
        });
      }
      res.status(200).json({ message: "Backup completed successfully" });
    } finally {
      client.release(); // Ensure the database connection is released
    }
  } catch (error) {
    console.error("General error:", error);
    res.status(500).json({ error: "An unexpected error occurred" });
  }
});

app.post("/restoreBackupTables", async (req, res) => {
  try {
    console.log("Restoring backup tables ", path.join(backupDir, "table"));
    if (!fs.existsSync(path.join(backupDir, "table"))) {
      res.status(404).send({ error: "Back up table csv file not found" });
    }

    const client = await db.connect();
    const errors = []; // Collect errors during the process

    try {
      // Process all tables
      await Promise.all(
        allDatabaseTables.map(async (tableName) => {
          try {
            let tableDir = path.join(backupDir, "table");
            console.log("Restoring table:", tableName);
            await client.query(
              `CREATE TEMPORARY TABLE temp_${tableName} AS SELECT * FROM ${tableName} WITH NO DATA;`
            );
            // Validate tableName to prevent SQL injection
            if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
              throw new Error("Invalid table name");
            }

            const filePath = path.join(tableDir, `${tableName}.csv`);
            const query = `COPY temp_${tableName} FROM STDIN WITH CSV HEADER;`;
            const fileStream = fs.createReadStream(filePath);
            const stream = client.query(copyFrom(query));

            console.log(
              `Starting restoration of ${tableName} from ${filePath}`
            );
            await pipeline(fileStream, stream);
            await client.query(restoreTableQuery(tableName));
            console.log(`Restoration of ${tableName} completed successfully`);
          } catch (error) {
            console.error(`Error backing up ${tableName}:`, error);
            errors.push({ table: tableName, error: error.message });
          }
        })
      );

      // Send final response after processing all tables
      if (errors.length > 0) {
        return res.status(500).json({
          message: "Table Restoration completed with errors",
          errors,
        });
      }
      res.status(200).send({ message: "Restoration successful" });
    } finally {
      client.release(); // Ensure the database connection is released
    }
    /*

    // Validate tableName to prevent SQL injection
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
      return res.status(400).send({ error: "Invalid table name" });
    }

    // Directory and file validation
    const tableDir = path.join(backupDir, "table");
    const filePath = path.join(tableDir, `${tableName}.csv`);

    // Connect to the database
    const client = await db.connect();

    try {
      await client.query(
        `CREATE TEMPORARY TABLE temp_${tableName} AS SELECT * FROM ${tableName} WITH NO DATA;`
      );
      const query = `COPY temp_${tableName} FROM STDIN WITH CSV HEADER;`;
      const fileStream = fs.createReadStream(filePath);
      const stream = client.query(copyFrom(query));

      console.log(`Starting restoration of ${tableName} from ${filePath}`);
      await pipeline(fileStream, stream);
      await client.query(restoreTableQuery(tableName));
      console.log(`Restoration of ${tableName} completed successfully`);

      res.status(200).send({ message: "Restoration successful" });
    } catch (error) {
      console.error(`Error restoring ${tableName}:`, error);
      res.status(500).send({ error: "Failed to restore table" });
    } finally {
      client.release();
    }
      */
  } catch (error) {
    console.error("General error:", error);
    res.status(500).send({ error: "An unexpected error occurred" });
  }
});

/*
// Schedule the backup at 2:00 AM daily
cron.schedule(
  "0 2 * * *",
  async () => {
    try {
      const dbPath = await backupDatabase();
      if (dbPath) {
        console.log("Database backed up successfully at:", dbPath);
        const backUpResponse = await db.query("SELECT * FROM backUps");
        const dateStr = new Date().toLocaleString(); // Format as yyyy-MM-dd-HH-mm-ss
        if (backUpResponse.rows.length > 0) {
          await db.query("UPDATE backUps SET backup_time = $1 WHERE id = $2", [
            dateStr,
            1,
          ]);
        } else {
          await db.query("INSERT INTO backUps (backup_time) VALUES ($1)", [
            dateStr,
          ]);
        }
      } else {
        console.log("Failed to backup database.");
      }
    } catch (err) {
      console.error("An Error occured when backing up database ", err.stack);
    }
  },
  {
    timezone: "Africa/Nairobi",
  }
);
*/

//fetch last backUp time
app.get("/last-backup", async (req, res) => {
  try {
    const response = await db.query("SELECT backup_time FROM backUps");
    //console.log("Last backup time:", response.rows[0]);
    res.status(200).send({ lastBackupTime: response.rows[0].backup_time });
  } catch (err) {
    console.error("An Error occured when fetching last backup time", err.stack);
  }
});

/*************RESTORE DATABASE **********/
//restore code
const restoreBackupDatabase = async () => {
  const backupPath = path.join(backupDir, "js_collection.sql");

  if (!fs.existsSync(backupPath)) {
    console.log("Backup directory not found at", backupPath);
    return;
  }

  try {
    console.log("Restoring from backup directory:", backupPath);

    // Execute the pgRestore command with the directory format
    const { stdout, stderr } = await pgRestore(
      {
        port: 5432,
        host: process.env.SESSION_DATABASE_HOST,
        database: process.env.SESSION_DATABASE_NAME,
        username: process.env.SESSION_DATABASE_USER,
        password: process.env.SESSION_DATABASE_PASSWORD,
      },
      {
        file: backupPath,
      }
    );

    // Check for errors
    if (stderr) {
      console.error("Error during restore:", stderr);
      return stderr;
    }

    console.log("Restore successful:", stdout);
    return stdout;
  } catch (err) {
    console.error("Error during restore operation:", err);
    return null;
  }
};

app.post("/restore", async (req, res) => {
  try {
    await restoreBackupDatabase();
    res.status(200).send({ message: "Database restored successfully" });
    console.log("Database restored successfully");
  } catch (err) {
    console.error("An Error occured when restoring database ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

/*************USERS*****************/
//return all users from the database
app.get("/users", async (req, res) => {
  try {
    let users = await db.query("SELECT * FROM users");
    res.status(200).json(users.rows);
  } catch (err) {
    console.error("An Error occured when getting users from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//forgotPassword
app.post("/forgot-password", async (req, res) => {
  const email = req.body.email;
  console.log("Email for reset is:", email);

  try {
    // Check if the user exists
    const userResult = await db.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);

    if (userResult.rows.length === 0) {
      // Always return a generic response for security
      return res.status(200).send({
        message:
          "If a user with that email exists, a password reset link will be sent.",
      });
    }

    const user = userResult.rows[0];

    // Create reset token with user's email, expiring in 15 minutes
    const resetToken = jwt.sign({ email: user.email }, jwtTokenSecret, {
      expiresIn: "15m",
    });

    // Create reset URL
    const resetUrl = `${process.env.SESSION_CORS_CLIENT_URL}/reset-password/${resetToken}`;

    // Email options
    const mailOptions = {
      from: process.env.SESSION_EMAIL_SENDER,
      to: email,
      subject: "Password Reset Request",
      text: `You requested a password reset. Please click on the following link to reset your password: ${resetUrl}\n\nThis link will expire in 15 minutes.`,
    };

    // Send the reset email
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error("Error sending email:", error);
        return res.status(500).send({ error: "Error sending email" });
      }
      res
        .status(200)
        .send({ message: "Password reset email sent successfully." });
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).send({ error: "Internal server error" });
  }
});

//reset password
app.post("/reset-password/:token", async (req, res) => {
  const token = req.params.token;
  const { password } = req.body;

  try {
    const decoded = jwt.verify(token, process.env.SESSION_JWT_TOKEN_SECRET);
    const user = await db.query("SELECT * FROM users WHERE email = $1", [
      decoded.email,
    ]);

    if (!user || !password) {
      return res.status(404).send({ error: "User not found" });
    }

    //password hashing
    bcrypt.hash(password, saltRounds, async (err, hash) => {
      if (err) {
        console.log("Error while Hashing", err);
        return res.status(500).send("Internal server error");
      } else {
        const query = "UPDATE users SET password=$1 WHERE email=$2";
        const values = [hash, decoded.email];
        await db.query(query, values);
        res.status(200).send("Password reset successful");
      }
    });
  } catch (err) {
    console.log("Error reseting password: ", err.message);
    res.status(400).send("Invalid or expired token");
  }
});

//get user_id
app.get("/new-user-id", async (req, res) => {
  try {
    let users = await db.query("SELECT * FROM users");
    let userId = 1;
    if (users.rows.length > 0) {
      userId = users.rows.at(-1).user_id + 1;
    }
    res.json(userId);
  } catch (err) {
    console.error("An Error occured when getting user id from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//get specific user
app.get("/users/:id", async (req, res) => {
  try {
    let id = parseInt(req.params.id);
    //use parameterized query to prevent sql injections
    //check if id exist
    const users = await db.query("SELECT * FROM users WHERE user_id =$1", [id]);
    if (users.rows.length === 0) {
      return res.status(404).send({ error: "User not found" });
    }
    res.json(users.rows);
  } catch (err) {
    console.error("An Error occured when getting users from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//user name from user ID
//get specific user
app.get("/users-name/:id", async (req, res) => {
  try {
    let id = parseInt(req.params.id);
    //use parameterized query to prevent sql injections
    //check if id exist
    const users = await db.query(
      "SELECT username FROM users WHERE user_id =$1",
      [id]
    );
    if (users.rows.length === 0) {
      return res.status(404).send({ error: "User not found" });
    }
    res.json(users.rows);
  } catch (err) {
    console.error("An Error occured when getting users from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});
//filter with username
app.get("/users-filter", async (req, res) => {
  try {
    const username = req.query.username;
    console.log(username);

    //use parameterized query to prevent sql injections
    const query = "SELECT * FROM users WHERE username = $1";
    if (query.rows.length === 0) {
      return res.status(404).send({ error: "User not found" });
    }
    let users = await db.query(query, [username]);
    res.status(200).json(users.rows);
  } catch (err) {
    console.error("An Error occured when getting users from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//insert into users
app.post("/users-register", async (req, res) => {
  try {
    const { username, email, password, is_disabled } = req.body;
    //check if username exists
    const checkUserName = await db.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );
    const checkUser = await db.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);
    if (checkUser.rows.length > 0 && checkUserName.rows.length > 0) {
      return res.status(409).send("User Exists");
    } else {
      //password hashing
      bcrypt.hash(password, saltRounds, async (err, hash) => {
        if (err) {
          console.log("Error while Hashing", err);
        } else {
          const query =
            "INSERT INTO users (username, email, password, is_disabled, created_at, updated_at) VALUES($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *;";
          const values = [username, email, hash, is_disabled || false];
          const results = await db.query(query, values);
          res.status(200).json(results.rows[0]);
        }
      });
    }
  } catch (err) {
    console.error("An Error occured when getting userss from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//check if users is authenitcated once they hit this route then give them user data
app.get("/users-login", (req, res) => {
  const authHeader = req.headers.authorization;
  console.log(authHeader);
  if (authHeader) {
    const token = authHeader.split(" ")[1];
    console.log(token);
    console.log(req.sessionID);
    if (req.sessionID === token && req.isAuthenticated()) {
      res.status(200).json({
        user: {
          user_id: req.user.user_id,
          username: req.user.username,
          email: req.user.email,
          user_type: req.user.user_type,
          authHeader: authHeader,
          token: token,
        },
      });
    } else {
      res.status(401).send({ error: "Not Authorised" });
    }
  } else {
    res.status(401).send({ error: "No Authorization Header Found" });
  }
});

//delete sesssion on log out
app.delete("/users-session-delete", (req, res) => {
  req.logout((err) => {
    if (err) return next(err);

    req.session.destroy((err) => {
      if (err) return next(err);

      res.clearCookie("connect.sid");
      res.status(200).json({ message: "Logged out successfully" });
    });
  });
});

//login user with passport local store sesssion
app.post(
  "https://jscollectionbackend.onrender.com/users-login",
  function (req, res, next) {
    passport.authenticate("local", (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        //display wrong login info
        return res.status(401).send(info);
      }

      //successful
      req.login(user, { session: false }, (err) => {
        if (err) return next(err);

        //generate token when user is logging in
        const token = jwt.sign(
          {
            user_id: req.user.user_id,
          },
          jwtTokenSecret,
          { expiresIn: "10h" }
        );

        //req.user contains the authenticated user
        return res.status(201).json({
          user: {
            user_id: req.user.user_id,
            username: req.user.username,
            email: req.user.email,
            user_type: req.user.user_type,
          },
          token: token,
        });
      });
    })(req, res, next);
  }
);

//authenticate user session
app.get(
  "/verify-user-token",
  passport.authenticate("jwt", { session: false }),
  (req, res) => {
    res.status(200).json({
      user: {
        user_id: req.user.user_id,
        username: req.user.username,
        email: req.user.email,
        user_type: req.user.user_type,
      },
    });
  }
);

/*
//passport.login with custom passport error message
app.post("/users-login", passport.authenticate("local"), (req, res) => {
  res.status(200).json(req.user);
});

//check if user name and password match
app.post("/users-login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (email === "" || password === "") {
      res.status(404).send({ error: "Email/ Password error" });
    }
    const results = await db.query("SELECT * FROM users WHERE email = $1;", [
      email,
    ]);
    if (results.rows.length === 0) {
      //no username
      res.status(404).send({ error: "Email/ Password error" });
    }
    const user = results.rows[0];
    //check if password matches
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(404).send({ error: "Email/ Password error" });
    }
    const userData = {
      user_id: user.user_id,
      username: user.username,
    };
    res.status(200).json(userData);
  } catch (err) {
    console.error("An Error occured when getting users from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});
*/

//update users record every thing
app.put("/users/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    //check if id exist
    const userResult = await db.query("SELECT * FROM users WHERE user_id =$1", [
      id,
    ]);
    if (userResult.rows.length === 0) {
      return res.status(404).send({ error: "User not found" });
    }
    const existingUser = userResult.rows[0];

    let { username, email, password, is_disabled, user_type } = req.body;

    //password hashing
    if (password) {
      password = await bcrypt.hash(password, saltRounds);
    } else {
      password = existingUser.password;
    }

    const query =
      "UPDATE users SET username =$2, email=$3, password=$4, is_disabled=$5, user_type=$6, updated_at=CURRENT_TIMESTAMP WHERE user_id = $1 RETURNING *;";
    const values = [
      id,
      username || existingUser.username,
      email || existingUser.email,
      password || existingUser.password,
      is_disabled || existingUser.is_disabled,
      user_type || existingUser.user_type,
    ];
    console.log("query", query);
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error("An Error occured when getting users from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//update users record potion
app.patch("/users/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    //get the current user data
    const userResult = await db.query("SELECT * FROM users WHERE user_id =$1", [
      id,
    ]);
    if (userResult.rows.length === 0) {
      return res.status(404).send({ error: "User not found" });
    }
    const userData = userResult.rows[0];

    let { username, email, password, is_disabled } = req.body;

    //password hashing
    if (password) {
      password = await bcrypt.hash(password, saltRounds);
    } else {
      password = existingUser.password;
    }

    const query =
      "UPDATE users SET username =$1, email=$2, password=$3, is_disabled=$4, updated_at=CURRENT_TIMESTAMP WHERE user_id = $5 RETURNING *;";
    const values = [
      username || userData.username,
      email || userData.email,
      password || userData.password,
      is_disabled || userData.is_disabled,
      id,
    ];
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error("An Error occured when getting users from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//delete user
app.delete("/users/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    //get the current user data
    const userResult = await db.query("SELECT * FROM users WHERE user_id =$1", [
      id,
    ]);
    if (userResult.rows.length === 0) {
      return res.status(404).send({ error: "User not found" });
    }

    await db.query("DELETE FROM users WHERE user_id = $1", [id]);
    res.status(200);
  } catch (err) {
    console.error("An Error occured when getting users from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

// delete selected user ids
app.delete("/users", async (req, res) => {
  try {
    const ids = req.body.ids;

    if (!ids || ids.length === 0) {
      return res.status(400).send({ error: "No user IDs provided" });
    }

    // Ensure all ids are numbers
    const idArray = ids.map((id) => parseInt(id, 10));

    // Check if the users exist
    const userResult = await db.query(
      "SELECT user_id FROM users WHERE user_id = ANY($1::int[])",
      [idArray]
    );

    if (userResult.rows.length === 0) {
      return res
        .status(404)
        .send({ error: "No users found with provided IDs" });
    }

    // Delete users
    await db.query("DELETE FROM users WHERE user_id = ANY($1::int[])", [
      idArray,
    ]);

    res.status(200).send({ message: "users deleted successfully" });
  } catch (err) {
    console.error("An error occurred when deleting user from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//delete
app.delete("/users-delete-all", async (req, res) => {
  try {
    const userKey = req.query.key;
    if (userKey === masterKey) {
      await db.query("DELETE FROM users");
      res.status(200);
    } else {
      return res.status(404).send({ error: "Unauthorized access" });
    }
  } catch (err) {
    console.error("An Error occured when getting users from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

/*************PRODUCTS*****************/
//return all products from the database
app.get("/products", async (req, res) => {
  try {
    const columnsToDisplay = [
      "product_id",
      "name",
      "description",
      "price",
      "stock",
      "images",
      "products.is_disabled",
      "category",
    ];

    let query = `
      SELECT ${columnsToDisplay.join(", ")} 
      FROM public.products 
      INNER JOIN public.categories 
      ON public.products.category_id = public.categories.category_id
      WHERE public.products.stock > 0
    `;

    let products = await db.query(query);
    res.status(200).json(products.rows);
  } catch (err) {
    console.error(
      "An Error occurred when getting products from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//get specific product using ID
app.get("/products/:id", async (req, res) => {
  try {
    let id = parseInt(req.params.id);
    //use parameterized query to prevent sql injections
    //check if id exist
    const products = await db.query(
      "SELECT * FROM products WHERE product_id =$1",
      [id]
    );
    if (products.rows.length === 0) {
      return res.status(404).send({ error: "product not found" });
    }
    res.json(products.rows);
  } catch (err) {
    console.error("An Error occured when getting products from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//filter with category
app.get("/products-filter", async (req, res) => {
  try {
    const category = req.query.category;
    console.log(category);

    //use parameterized query to prevent sql injections
    const query = "SELECT * FROM products WHERE category = $1";
    if (query.rows.length === 0) {
      return res.status(404).send({ error: "product not found" });
    }
    let products = await db.query(query, [category]);
    res.status(200).json(products.rows);
  } catch (err) {
    console.error("An Error occured when getting products from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//insert into products
app.post("/products", async (req, res) => {
  try {
    const { name, desc, price, stock, images, category, is_disabled } =
      req.body.newProduct;

    console.log("product to upload ", req.body.newProduct);

    //get the category Id
    const categoryId = await db.query(
      "SELECT category_id FROM categories WHERE category = $1",
      [category]
    );

    const query =
      "INSERT INTO products (name, description, price, stock, images, category_id, is_disabled, created_at, updated_at) VALUES($1, $2, $3, $4, $5,$6,$7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *;";
    const values = [
      name,
      desc,
      price,
      stock,
      images,
      categoryId.rows[0].category_id,
      is_disabled,
    ];
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error("An Error occured when getting products from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

app.put("/products/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // Check if the product exists
    const productResult = await db.query(
      "SELECT * FROM products WHERE product_id = $1",
      [id]
    );
    if (productResult.rows.length === 0) {
      return res.status(404).send({ error: "Product not found" });
    }

    const { name, desc, price, stock, images, category, is_disabled } =
      req.body.newProduct;

    console.log("newProduct is ", req.body.newProduct);

    // Get the category ID
    const categoryIdResult = await db.query(
      "SELECT category_id FROM categories WHERE category = $1",
      [category]
    );
    if (categoryIdResult.rows.length === 0) {
      return res.status(404).send({ error: "Category not found" });
    }
    const categoryId = categoryIdResult.rows[0].category_id;

    // Existing product details
    const existingProduct = productResult.rows[0];

    // Update product details
    const query = `
      UPDATE products 
      SET name = $1, description = $2, price = $3, stock = $4, images = $5, category_id = $6, is_disabled = $7, updated_at = CURRENT_TIMESTAMP 
      WHERE product_id = $8 
      RETURNING *;
    `;
    const values = [
      name || existingProduct.name,
      desc || existingProduct.description,
      price || existingProduct.price,
      stock || existingProduct.stock,
      images || existingProduct.images,
      categoryId,
      is_disabled !== undefined ? is_disabled : existingProduct.is_disabled,
      id,
    ];

    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An error occurred when updating the product in the database",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//update users record potion
app.patch("/products/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    //get the current product data
    const productResult = await db.query(
      "SELECT * FROM products WHERE product_id =$1",
      [id]
    );
    if (productResult.rows.length === 0) {
      return res.status(404).send({ error: "product not found" });
    }
    const productData = productResult.rows[0];

    const { name, desc, price, stock, images, category, is_disabled } =
      req.body;

    const query =
      ("UPDATE products SET name =$1, desc=$2, price=$3, stock=$4, images=$5, is_disabled=$6, category=$7, updated_at=CURRENT_TIMESTAMP WHERE product_id = ${id} RETURNING *;",
      [id]);
    const values = [
      name || productData.name,
      desc || productData.desc,
      price || productData.price,
      stock || productData.stock,
      images || productData.images,
      is_disabled || productData.is_disabled,
      category || productData.category,
    ];
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error("An Error occured when getting products from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//delete product
app.delete("/products/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    //get the current product data
    const productResult = await db.query(
      "SELECT * FROM products WHERE product_id =$1",
      [id]
    );
    if (productResult.rows.length === 0) {
      return res.status(404).send({ error: "product not found" });
    }

    await db.query("DELETE FROM products WHERE product_id = $1", [id]);
    res.status(200);
  } catch (err) {
    console.error("An Error occured when getting products from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

// delete selected product ids
app.delete("/products", async (req, res) => {
  try {
    const ids = req.body.ids;

    if (!ids || ids.length === 0) {
      return res.status(400).send({ error: "No product IDs provided" });
    }

    // Ensure all ids are numbers
    const idArray = ids.map((id) => parseInt(id, 10));

    // Check if the products exist
    const productResult = await db.query(
      "SELECT product_id FROM products WHERE product_id = ANY($1::int[])",
      [idArray]
    );

    if (productResult.rows.length === 0) {
      return res
        .status(404)
        .send({ error: "No products found with provided IDs" });
    }

    // Delete users
    await db.query("DELETE FROM products WHERE product_id = ANY($1::int[])", [
      idArray,
    ]);

    res.status(200).send({ message: "products deleted successfully" });
  } catch (err) {
    console.error(
      "An error occurred when deleting product from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//delete all
app.delete("/products-delete-all", async (req, res) => {
  try {
    const userKey = req.query.key;
    if (userKey === masterKey) {
      await db.query("DELETE FROM products");
      res.status(200);
    } else {
      return res.status(404).send({ error: "Unauthorized access" });
    }
  } catch (err) {
    console.error("An Error occured when getting products from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

/**************ORDERS***************/
//get all orders
app.get("/orders", async (req, res) => {
  try {
    let orders = await db.query("SELECT * FROM orders");
    res.status(200).json(orders.rows);
  } catch (err) {
    console.error("An Error occured when getting orders from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//get order id
app.get("/new-order-id", async (req, res) => {
  try {
    let orders = await db.query("SELECT * FROM orders");
    let newOrderId = 1;
    if (orders.rows.length > 0) {
      newOrderId = orders.rows.at(-1).order_id + 1;
    }
    res.json(newOrderId);
  } catch (err) {
    console.error("An Error occured when getting order id from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//get user orders with status draft
app.get("/user-orders/:id", async (req, res) => {
  try {
    let id = parseInt(req.params.id);
    //check if id exist
    const orders = await db.query(
      "SELECT * FROM orders WHERE user_id =$1 AND status='draft' ",
      [id]
    );
    if (orders.rows.length === 0) {
      return res.status(404).send({ error: "order not found" });
    }
    const ordersResult = orders.rows;
    res.json(ordersResult[ordersResult.length - 1]);
  } catch (err) {
    console.error("An Error occured when getting orders from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//get specific order using ID
app.get("/orders/:id", async (req, res) => {
  try {
    let id = parseInt(req.params.id);
    //check if id exist
    const orders = await db.query("SELECT * FROM orders WHERE order_id =$1", [
      id,
    ]);
    if (orders.rows.length === 0) {
      return res.status(404).send({ error: "order not found" });
    }
    res.json(orders.rows);
  } catch (err) {
    console.error("An Error occured when getting orders from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//get specific order for a specific user
app.get("/user-order/:id", async (req, res) => {
  try {
    let id = parseInt(req.params.id);
    //check if id exist
    const orders = await db.query(
      "SELECT * FROM orders WHERE user_id = $1 AND status = 'Pending'",
      [id]
    );
    if (orders.rows.length === 0) {
      return res.status(404).send({ error: "order not found" });
    }
    res.json(orders.rows[0]);
  } catch (err) {
    console.error("An Error occured when getting orders from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//insert into orders
app.post("/orders", async (req, res) => {
  try {
    const { order_id, user_id, total, status } = req.body.newOrder;
    let query, values;
    console.log(req.body.newOrder);

    if (order_id === null) {
      query =
        "INSERT INTO orders ( user_id, total, status, created_at, updated_at) VALUES($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *;";
      values = [user_id, total, status];
    } else {
      query =
        "INSERT INTO orders (order_id, user_id, total, status, created_at, updated_at) VALUES($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *;";
      values = [order_id, user_id, total, status];
    }
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error("An Error occured when inserting orders to db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//change quantity of all order items
async function changeStockQuantity(order_id) {
  try {
    const orderItems = await db.query(
      "SELECT * FROM order_item WHERE order_id = $1",
      [order_id]
    );

    if (orderItems.rows.length === 0) {
      return { status: 404, error: "Order items not found" };
    }

    const updateResults = await Promise.all(
      orderItems.rows.map(async (item) => {
        const product = await db.query(
          "SELECT * FROM products WHERE product_id = $1",
          [item.product_id]
        );

        if (product.rows.length === 0) {
          return { status: 404, error: "Product not found" };
        }

        const currentStock = product.rows[0].stock;
        const updatedStock = currentStock - item.quantity;

        if (updatedStock < 0) {
          return { status: 400, error: "Insufficient stock" };
        }

        const updateStockInDB = await db.query(
          "UPDATE products SET stock = $1 WHERE product_id = $2 RETURNING *",
          [updatedStock, item.product_id]
        );

        if (updateStockInDB.rows.length === 0) {
          return { status: 500, error: "Failed to update stock" };
        }

        return { status: 200, error: null };
      })
    );

    // Check for any errors in update results
    const hasErrors = updateResults.some((result) => result.status !== 200);
    if (hasErrors) {
      console.error("Stock update errors:", updateResults);
      return { status: 500, error: "Some stock updates failed" };
    }

    return { status: 200, error: null };
  } catch (err) {
    console.error(
      "An error occurred while updating stock quantities:",
      err.stack
    );
    return { status: 500, error: "Internal server error" };
  }
}

//update orders record every thing
app.put("/orders/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    //check if id exist
    const orderResult = await db.query(
      "SELECT * FROM orders WHERE order_id =$1",
      [id]
    );
    if (orderResult.rows.length === 0) {
      return res.status(404).send({ error: "order not found" });
    }
    const { order_id, user_id, total, status, description } = req.body;
    console.log("order description ", description);

    const query =
      "UPDATE orders SET order_id = $1, user_id=$2, total =$3, status = $4, description =$5, updated_at=CURRENT_TIMESTAMP WHERE order_id = $1 RETURNING *;";
    const existingOrder = orderResult.rows[0];
    const values = [
      order_id || existingOrder.order_id,
      user_id || existingOrder.user_id,
      total || existingOrder.total,
      status || existingOrder.status,
      description || existingOrder.description,
    ];
    const results = await db.query(query, values);

    //Send email notification to seller once order is placed
    if (status === "pending_approval") {
      const mailOptions = {
        from: process.env.SESSION_EMAIL_SENDER,
        to: process.env.SESSION_EMAIL_SENDER,
        subject: "New Order Placed",
        text: `Hello,
        You have a new order, order number ${
          order_id || existingOrder.order_id
        } awaiting your verification

        Regards,
        JS Collection System`,
      };
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.error("Error sending email:", error);
          return res
            .status(500)
            .send({ error: "Error sending email notification" });
        }
        console.log("New order notification email sent:", info.response);
      });
    }

    if (status === "paid") {
      const changeStockStatus = await changeStockQuantity(order_id);

      if (changeStockStatus.status !== 200) {
        return res
          .status(changeStockStatus.status)
          .send({ error: changeStockStatus.error });
      }

      // Continue with other logic after stock update
      return res.status(200).send({ message: "Stock updated successfully" });
    }

    return res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An Error occured when updating order subtotal order from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//format text
function transformData(data) {
  const result = [];

  // Helper to find or create an entry for a given month
  const findOrCreateMonth = (month) => {
    let entry = result.find((item) => item.month === month.trim());
    if (!entry) {
      entry = { month: month.trim(), paid: 0, pending_approval: 0, draft: 0 };
      result.push(entry);
    }
    return entry;
  };

  // Process raw data
  data.forEach(({ month, status, count }) => {
    const entry = findOrCreateMonth(month);
    entry[status] = (entry[status] || 0) + parseInt(count, 10);
  });

  return result;
}

//create order dataset per month
app.get("/orders-dataset-monthly", async (req, res) => {
  try {
    const orderDataset = await db.query(
      "SELECT TO_CHAR(created_at, 'Month') AS month, status, COUNT(*) AS count FROM orders WHERE EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE) GROUP BY month, status ORDER BY month;"
    );
    const formattedData = transformData(orderDataset.rows);
    return res.status(200).json(formattedData);
  } catch (err) {
    console.error("Error when getting dataset of order status ", err.stack);
  }
});

//delete order
app.delete("/orders/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    //get the current product data
    const orderResult = await db.query(
      "SELECT * FROM orders WHERE order_id =$1",
      [id]
    );
    if (orderResult.rows.length === 0) {
      return res.status(404).send({ error: "order not found" });
    }

    await db.query("DELETE FROM orders WHERE order_id = $1", [id]);
    res.status(200);
  } catch (err) {
    console.error("An Error occured when deleting order from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

// delete selected order ids
app.delete("/orders", async (req, res) => {
  try {
    const ids = req.body.ids;
    console.log("Deleting order", ids);

    if (!ids || ids.length === 0) {
      return res.status(400).send({ error: "No order IDs provided" });
    }

    // Ensure all ids are numbers
    const idArray = ids.map((id) => parseInt(id, 10));

    // Check if the orders exist
    const orderResult = await db.query(
      "SELECT order_id FROM orders WHERE order_id = ANY($1::int[])",
      [idArray]
    );

    if (orderResult.rows.length === 0) {
      return res
        .status(404)
        .send({ error: "No orders found with provided IDs" });
    }

    // Delete users
    await db.query("DELETE FROM orders WHERE order_id = ANY($1::int[])", [
      idArray,
    ]);

    res.status(200).send({ message: "users deleted successfully" });
  } catch (err) {
    console.error("An error occurred when deleting user from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

/**************ORDER ITEMS *********/
//get order item id
app.get("/new-order_item-id", async (req, res) => {
  try {
    let orderItems = await db.query("SELECT * FROM order_item");
    let orderItemId = 1;
    if (orderItems.rows.length > 0) {
      orderItemId = orderItems.rows.at(-1).order_item_id + 1;
    }
    res.json(orderItemId);
  } catch (err) {
    console.error(
      "An Error occured when getting order item id from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//insert into order items
app.post("/order_item", async (req, res) => {
  try {
    let { order_id, order_item_id, product_id, quantity, price, total } =
      req.body.newOrderItem;

    total = quantity * price;

    let query, values;

    if (order_item_id === null) {
      query =
        "INSERT INTO order_item (order_id, product_id, quantity, price, total, created_at, updated_at) VALUES($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *;";
      values = [order_id, product_id, quantity, price, total];
    } else {
      query =
        "INSERT INTO order_item (order_id, order_item_id, product_id, quantity, price, total, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *;";
      values = [order_id, order_item_id, product_id, quantity, price, total];
    }

    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An Error occured when inserting order items to db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//update order items record every thing
app.put("/order_item/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    //check if id exist
    const orderResult = await db.query(
      "SELECT * FROM order_item WHERE order_item_id =$1",
      [id]
    );
    if (orderResult.rows.length === 0) {
      return res.status(404).send({ error: "order not found" });
    }

    let { order_id, product_id, order_item_id, quantity, price, total } =
      req.body.ordersToUpdate;

    total = quantity * price;

    const query =
      "UPDATE order_item SET order_id=$1, order_item_id=$2, product_id = $3, quantity=$4, price=$5, total =$6, updated_at=CURRENT_TIMESTAMP WHERE order_item_id = $2 RETURNING *;";
    const existingOrder = orderResult.rows[0];
    const values = [
      order_id || existingOrder.order_id,
      order_item_id || existingOrder.order_item_id,
      product_id || existingOrder.product_id,
      quantity || existingOrder.quantity,
      price || existingOrder.price,
      total || existingOrder.total,
    ];
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An Error occured when updating order item from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//get user order items with the order id of the user
app.get("/user-order_items/:id", async (req, res) => {
  try {
    let id = parseInt(req.params.id);
    //check if id exist
    const orders = await db.query(
      "SELECT * FROM order_item WHERE order_id =$1",
      [id]
    );
    if (orders.rows.length === 0) {
      return res.status(404).send({ error: "order not found" });
    }
    res.json(orders.rows);
  } catch (err) {
    console.error("An Error occured when getting orders from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//validate orderItem stock quantity
app.get(
  "/order_item-stock/:orderId/:orderItemId/:productId",
  async (req, res) => {
    try {
      let orderId = parseInt(req.params.orderId);
      let orderItemId = parseInt(req.params.orderItemId);
      let productId = parseInt(req.params.productId);

      //check if order id or orderItemId is not a number
      if (isNaN(orderId) && isNaN(orderItemId) && isNaN(productId)) {
        return res
          .status(400)
          .send({ error: "Invalid order ID or order Item ID" });
      }

      //check if order id exist
      const orders = await db.query("SELECT * FROM orders WHERE order_id =$1", [
        orderId,
      ]);
      if (orders.rows.length === 0) {
        return res.status(404).send({ error: "order not found" });
      }

      //check if order item id exist
      const orderItems = await db.query(
        "SELECT quantity FROM order_item WHERE order_item_id =$1",
        [orderItemId]
      );

      if (orderItems.rows.length === 0) {
        return res
          .status(404)
          .send({ error: "unable to fetch order item stock quantity" });
      }

      //verify product quantity and order item quantity
      const product = await db.query(
        "SELECT name, stock FROM products WHERE product_id =$1",
        [productId]
      );
      if (product.rows.length === 0) {
        return res
          .status(404)
          .send({ error: "unable to fetch product quantity" });
      }
      const productQuantity = product.rows[0].stock;
      const orderItemQuantity = orderItems.rows[0].quantity;
      if (orderItemQuantity > productQuantity) {
        // Insufficient stock
        return res.status(422).json({
          error: "Insufficient stock.",
          p_name: product.rows[0].name,
          quantity: productQuantity,
        });
      }

      // Stock validation passed
      return res
        .status(200)
        .json({ p_name: product.rows[0].name, quantity: productQuantity });
    } catch (err) {
      console.error(
        "An Error occured when getting orderItem stock quantity from db ",
        err.stack
      );
      res.status(500).send({ error: err.stack });
    }
  }
);

//get orderItem Total Amount
app.get("/order_item-total/:id", async (req, res) => {
  try {
    let id = parseInt(req.params.id);
    //check if id exist
    const orders = await db.query(
      "SELECT total FROM order_item WHERE order_id =$1",
      [id]
    );
    if (orders.rows.length === 0) {
      return res.status(404).send({ error: "unable to calculate total" });
    }
    const subTotal = orders.rows.reduce(
      (acc, currentTotal) => acc + parseFloat(currentTotal.total),
      0
    );
    res.json({ total: subTotal });
  } catch (err) {
    console.error(
      "An Error occured when getting orderItem subtotal from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//delete order_item
app.delete("/order_item/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    //get the current product data
    const orderResult = await db.query(
      "SELECT * FROM order_item WHERE order_item_id =$1",
      [id]
    );
    if (orderResult.rows.length === 0) {
      return res.status(404).send({ error: "order_item not found" });
    }

    await db.query("DELETE FROM order_item WHERE order_item_id = $1", [id]);
    res.status(200).send({ message: "Order item deleted successfully" });
  } catch (err) {
    console.error(
      "An Error occured when deleting order_item from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

// delete selected order_item ids
app.delete("/order_item", async (req, res) => {
  try {
    const ids = req.body.ids;

    if (!ids || ids.length === 0) {
      return res.status(400).send({ error: "No order_item IDs provided" });
    }

    // Ensure all ids are numbers
    const idArray = ids.map((id) => parseInt(id, 10));

    // Check if the order_item exist
    const order_itemResult = await db.query(
      "SELECT order_item_id FROM order_item WHERE order_item_id = ANY($1::int[])",
      [idArray]
    );

    if (order_itemResult.rows.length === 0) {
      return res
        .status(404)
        .send({ error: "No order_items found with provided IDs" });
    }

    // Delete order_items
    await db.query(
      "DELETE FROM order_item WHERE order_item_id = ANY($1::int[])",
      [idArray]
    );

    res.status(200).send({ message: "order_item deleted successfully" });
  } catch (err) {
    console.error(
      "An error occurred when deleting order_item from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

/***************COLUMN NAMES *********/
/*******************************************NOTE*********************/
//EVERYTIME YOU CHANGE FIELD IN /column-name/:tableName CHANGE ALSO IN /table-data/:tableName && /table-data/:tableName/:id

//column headers
app.get("/column-name/:tableName", async (req, res) => {
  try {
    const table_name = req.params.tableName;
    let columnsToDisplay;
    //data to display in each
    switch (table_name) {
      case "orders":
        columnsToDisplay = [
          "order_id",
          "user_id",
          "username",
          "total",
          "status",
          "description",
        ];
        break;
      case "order_item":
        columnsToDisplay = [
          "order_item_id",
          "order_id",
          "product_id",
          "name",
          "quantity",
          "price",
          "total",
          "username",
        ];
        break;
      case "delivery_details":
        columnsToDisplay = [
          "delivery_id",
          "user_id",
          "order_id",
          "email",
          "country",
          "f_name",
          "l_name",
          "address",
          "city",
          "postal_code",
          "phone_number",
          "status",
          "description",
        ];
        break;
      case "users":
        columnsToDisplay = [
          "user_id",
          "username",
          "email",
          `user_type`,
          "is_disabled",
          "password",
        ];
        break;
      case "products":
        columnsToDisplay = [
          "product_id",
          "name",
          "description",
          "price",
          "stock",
          "images",
          "is_disabled",
          "category",
        ];
        break;
      case "categories":
        columnsToDisplay = ["category_id", "category", "is_disabled"];
        break;
      case "about":
        columnsToDisplay = [
          "about_id",
          "our_story",
          "mission",
          "vision",
          "images",
        ];
        break;
      case "customer_testimonial":
        columnsToDisplay = [
          "customer_testimonial_id",
          "name",
          "comment",
          "rating",
          "title",
          "avatar",
        ];
        break;
      case "newsletter":
        columnsToDisplay = ["newsletter_id", "email", "is_disabled"];
        break;
      case "slide_show":
        columnsToDisplay = ["slide_show_id", "title", "description", "image"];
        break;
      default:
        columnsToDisplay = [];
        break;
    }
    res.json(columnsToDisplay);
  } catch (err) {
    console.error("error when fetching column names ", err);
  }
});

//column data
app.get("/table-data/:tableName", async (req, res) => {
  try {
    const table_name = req.params.tableName;
    let columnsToDisplay = [];
    let query;

    // Validate table name to avoid SQL injection
    if (!/^[a-zA-Z0-9_]+$/.test(table_name)) {
      return res.status(400).send({ error: "Invalid table name" });
    }

    // Data to display in each table
    switch (table_name) {
      case "orders":
        columnsToDisplay = [
          "order_id",
          `${table_name}.user_id`,
          "username",
          "total",
          "status",
          "description",
        ];
        query = `SELECT ${columnsToDisplay.join(
          ", "
        )} FROM public.users INNER JOIN public.${table_name} ON public.users.user_id = public.${table_name}.user_id`;
        break;
      case "order_item":
        columnsToDisplay = [
          "order_item_id",
          "order_id",
          `${table_name}.product_id`,
          "name",
          "quantity",
          `${table_name}.price`,
          "total",
        ];
        query = `SELECT ${columnsToDisplay.join(
          ", "
        )} FROM public.${table_name} INNER JOIN public.products ON public.${table_name}.product_id = public.products.product_id`;
        break;
      case "delivery_details":
        columnsToDisplay = [
          "delivery_id",
          `${table_name}.user_id`,
          `${table_name}.order_id`,
          "email",
          "country",
          "f_name",
          "l_name",
          "address",
          "city",
          "postal_code",
          "phone_number",
          "status",
          "description",
        ];
        query = `SELECT ${columnsToDisplay.join(
          ", "
        )} FROM public.${table_name}`;
        break;
      case "users":
        columnsToDisplay = [
          "user_id",
          "username",
          "email",
          `user_type`,
          "is_disabled",
        ];
        query = `SELECT ${columnsToDisplay.join(
          ", "
        )} FROM public.${table_name} WHERE username != 'Administrator'`;
        break;
      case "products":
        columnsToDisplay = [
          "product_id",
          "name",
          "description",
          "price",
          "stock",
          "images",
          `${table_name}.is_disabled`,
          "category",
        ];
        query = `
        SELECT ${columnsToDisplay.join(", ")} 
        FROM public.${table_name} 
        INNER JOIN public.categories 
        ON public.${table_name}.category_id = public.categories.category_id
      `;
        break;
      case "categories":
        columnsToDisplay = ["category_id", "category", "is_disabled"];
        query = `
          SELECT ${columnsToDisplay.join(", ")} 
          FROM public.${table_name}
        `;
        break;
      case "about":
        columnsToDisplay = [
          "about_id",
          "our_story",
          "mission",
          "vision",
          "images",
        ];
        query = `
          SELECT ${columnsToDisplay.join(", ")} 
          FROM public.${table_name}
        `;
        break;
      case "customer_testimonial":
        columnsToDisplay = [
          "customer_testimonial_id",
          "name",
          "comment",
          "rating",
          "title",
          "avatar",
        ];
        query = `
          SELECT ${columnsToDisplay.join(", ")} 
          FROM public.${table_name}
        `;
        break;
      case "newsletter":
        columnsToDisplay = ["newsletter_id", "email", "is_disabled"];
        query = `
          SELECT ${columnsToDisplay.join(", ")} 
          FROM public.${table_name}
        `;
        break;
      case "slide_show":
        columnsToDisplay = ["slide_show_id", "title", "description", "image"];
        query = `
          SELECT ${columnsToDisplay.join(", ")} 
          FROM public.${table_name}
        `;
        break;
      default:
        return res.status(400).send({ error: "Invalid table name" });
    }

    const columnNames = await db.query(query);
    if (columnNames.rows.length === 0) {
      return res.status(200).json(null);
    }

    //add username to order_items data
    if (table_name === "order_item") {
      const orderItems = columnNames.rows;
      //fetch username for each orderItems using order_id
      const ordersWithproductNames = await Promise.all(
        orderItems.map(async (order) => {
          const orderIdResult = await db.query(
            "SELECT user_id FROM orders WHERE order_id = $1 ",
            [order.order_id]
          );
          if (orderIdResult.rows.length > 0) {
            const orderResult = await db.query(
              `SELECT username FROM public.users WHERE user_id = $1 `,
              [orderIdResult.rows[0].user_id]
            );
            return { ...order, username: orderResult.rows[0].username };
          } else {
            order.product_id = "No product found";
          }
          return order;
        })
      );
      res.status(200).json(ordersWithproductNames);
    } else {
      console.log(columnNames.rows);
      res.status(200).json(columnNames.rows);
    }
  } catch (err) {
    console.error("Error when fetching table data:", err);
    res.status(500).send({ error: "Internal server error" });
  }
});

//get row data of a certain table to edit with a certain id
app.get("/table-data/:tableName/:id", async (req, res) => {
  try {
    const table_name = req.params.tableName;
    const id = parseInt(req.params.id);
    let columnsToDisplay = [];
    let query;

    // Validate table name to avoid SQL injection
    if (!/^[a-zA-Z0-9_]+$/.test(table_name)) {
      return res.status(400).send({ error: "Invalid table name" });
    }

    // Data to display in each table
    switch (table_name) {
      case "orders":
        columnsToDisplay = [
          "order_id",
          `${table_name}.user_id`,
          "username",
          "total",
          "status",
          "description",
        ];
        query = `SELECT ${columnsToDisplay.join(
          ", "
        )} FROM public.users INNER JOIN public.${table_name} ON public.users.user_id = public.${table_name}.user_id WHERE public.${table_name}.order_id = ${id}`;
        break;
      case "order_item":
        columnsToDisplay = [
          "order_item_id",
          "order_id",
          `${table_name}.product_id`,
          "name",
          "quantity",
          `${table_name}.price`,
          "total",
        ];
        query = `SELECT ${columnsToDisplay.join(
          ", "
        )} FROM public.${table_name} INNER JOIN public.products ON public.${table_name}.product_id = public.products.product_id WHERE public.${table_name}.order_item_id = ${id}`;
        break;
      case "delivery_details":
        columnsToDisplay = [
          "delivery_id",
          `${table_name}.user_id`,
          `${table_name}.order_id`,
          "email",
          "country",
          "f_name",
          "l_name",
          "address",
          "city",
          "postal_code",
          "phone_number",
          "status",
          "description",
        ];
        query = `SELECT ${columnsToDisplay.join(
          ", "
        )} FROM public.${table_name} WHERE delivery_id = ${id}`;
        break;
      case "users":
        columnsToDisplay = [
          "user_id",
          "username",
          "email",
          `user_type`,
          "is_disabled",
        ];
        query = `SELECT ${columnsToDisplay.join(
          ", "
        )} FROM public.${table_name} WHERE user_id = ${id}`;
        break;
      case "products":
        columnsToDisplay = [
          "product_id",
          "name",
          "description",
          "price",
          "stock",
          "images",
          "products.is_disabled",
          "category",
        ];
        query = `
        SELECT ${columnsToDisplay.join(", ")} 
        FROM public.${table_name} 
        INNER JOIN public.categories 
        ON public.${table_name}.category_id = public.categories.category_id 
        WHERE product_id = ${id}`;
        break;
      case "categories":
        columnsToDisplay = ["category_id", "category", "is_disabled"];
        query = `
          SELECT ${columnsToDisplay.join(", ")} 
          FROM public.${table_name} WHERE category_id = ${id}
        `;
        break;
      case "about":
        columnsToDisplay = [
          "about_id",
          "our_story",
          "mission",
          "vision",
          "images",
        ];
        query = `
          SELECT ${columnsToDisplay.join(", ")} 
          FROM public.${table_name} WHERE about_id = ${id}
        `;
        break;
      case "customer_testimonial":
        columnsToDisplay = [
          "customer_testimonial_id",
          "name",
          "comment",
          "rating",
          "title",
          "avatar",
        ];
        query = `
          SELECT ${columnsToDisplay.join(", ")} 
          FROM public.${table_name} WHERE customer_testimonial_id = ${id}
        `;
        break;
      case "newsletter":
        columnsToDisplay = ["newsletter_id", "email", "is_disabled"];
        query = `
          SELECT ${columnsToDisplay.join(", ")} 
          FROM public.${table_name} WHERE newsletter_id = ${id}
        `;
        break;
      case "slide_show":
        columnsToDisplay = ["slide_show_id", "title", "description", "image"];
        query = `
          SELECT ${columnsToDisplay.join(", ")} 
          FROM public.${table_name} WHERE slide_show_id = ${id}
        `;
        break;
      default:
        return res.status(400).send({ error: "Invalid table name" });
    }

    const columnNames = await db.query(query);
    if (columnNames.rows.length === 0) {
      return res.status(404).send({ error: "Unable to fetch table data" });
    }

    //add username to order_items data
    if (table_name === "order_item") {
      const orderItems = columnNames.rows;
      //fetch username for each orderItems using order_id
      const ordersWithproductNames = await Promise.all(
        orderItems.map(async (order) => {
          const orderIdResult = await db.query(
            "SELECT user_id FROM orders WHERE order_id = $1 ",
            [order.order_id]
          );
          if (orderIdResult.rows.length > 0) {
            const orderResult = await db.query(
              `SELECT username FROM public.users WHERE user_id = $1 `,
              [orderIdResult.rows[0].user_id]
            );
            return { ...order, username: orderResult.rows[0].username };
          } else {
            order.product_id = "No product found";
          }
          return order;
        })
      );
      res.json(ordersWithproductNames);
    } else {
      res.json(columnNames.rows);
    }
  } catch (err) {
    console.error("Error when fetching table data:", err);
    res.status(500).send({ error: "Internal server error" });
  }
});

/**************** CATEGORIES *************/

app.get("/categories", async (req, res) => {
  try {
    let categories = await db.query("SELECT * FROM categories");
    res.status(200).json(categories.rows);
  } catch (err) {
    console.error(
      "An Error occured when getting categories from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//insert into categoriess
app.post("/categories", async (req, res) => {
  try {
    const { category, is_disabled } = req.body.newCategory;
    console.log(req.body.newCategory);

    const query =
      "INSERT INTO categories ( category, is_disabled) VALUES($1, $2) RETURNING *;";
    const values = [category, is_disabled];

    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An Error occured when inserting categories to db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

app.put("/categories/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    //check if id exist
    const categoryResult = await db.query(
      "SELECT * FROM categories WHERE category_id =$1",
      [id]
    );
    if (categoryResult.rows.length === 0) {
      return res.status(404).send({ error: "category not found" });
    }
    const { category, is_disabled } = req.body.newCategory;

    const query =
      "UPDATE categories SET category=$2, is_disabled =$3 WHERE category_id = $1 RETURNING *;";
    const existingCategory = categoryResult.rows[0];
    const values = [
      id,
      category || existingCategory.category,
      is_disabled || existingCategory.is_disabled,
    ];
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An Error occured when updating category from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

// delete category
app.delete("/categories", async (req, res) => {
  try {
    const ids = req.body.ids;

    if (!ids || ids.length === 0) {
      return res.status(400).send({ error: "No category IDs provided" });
    }

    // Ensure all ids are numbers
    const idArray = ids.map((id) => parseInt(id, 10));

    // Check if the categories exist
    const categoryResult = await db.query(
      "SELECT category_id FROM categories WHERE category_id = ANY($1::int[])",
      [idArray]
    );

    if (categoryResult.rows.length === 0) {
      return res
        .status(404)
        .send({ error: "No categories found with provided IDs" });
    }

    // Delete categories
    await db.query(
      "DELETE FROM categories WHERE category_id = ANY($1::int[])",
      [idArray]
    );

    res.status(200).send({ message: "Categories deleted successfully" });
  } catch (err) {
    console.error(
      "An error occurred when deleting category from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

/***************  ABOUT  **************************/

app.get("/about", async (req, res) => {
  try {
    let about = await db.query("SELECT * FROM about");
    res.status(200).json(about.rows[0]);
  } catch (err) {
    console.error("An Error occured when getting about from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

//insert into about
app.post("/about", async (req, res) => {
  try {
    const { our_story, mission, vision, images } = req.body.newAbout;

    const query =
      "INSERT INTO about (about_id, our_story, mission, vision, images) VALUES($1, $2, $3, $4, $5) RETURNING *;";
    const values = [1, our_story, mission, vision, images];

    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error("An Error occured when inserting about to db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

app.put("/about/:id", async (req, res) => {
  try {
    const id = 1;

    //check if id exist
    const aboutResult = await db.query(
      "SELECT * FROM about WHERE about_id =$1",
      [id]
    );
    if (aboutResult.rows.length === 0) {
      return res.status(404).send({ error: "about not found" });
    }
    const { our_story, mission, vision, images } = req.body.newAbout;

    const query =
      "UPDATE about SET our_story=$2, mission =$3, vision = $4, images = $5 WHERE about_id = $1 RETURNING *;";
    const existingAbout = aboutResult.rows[0];
    const values = [
      id,
      our_story || existingAbout.our_story,
      mission || existingAbout.mission,
      vision || existingAbout.vision,
      images || existingAbout.images,
    ];
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error("An Error occured when updating about from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});

// delete selected about ids
app.delete("/about", async (req, res) => {
  try {
    const ids = req.body.ids;

    if (!ids || ids.length === 0) {
      return res.status(400).send({ error: "No about IDs provided" });
    }

    // Ensure all ids are numbers
    const idArray = ids.map((id) => parseInt(id, 10));

    // Check if the about exist
    const aboutResult = await db.query(
      "SELECT about_id FROM about WHERE about_id = ANY($1::int[])",
      [idArray]
    );

    if (aboutResult.rows.length === 0) {
      return res
        .status(404)
        .send({ error: "No about found with provided IDs" });
    }

    // Delete about
    await db.query("DELETE FROM about WHERE about_id = ANY($1::int[])", [
      idArray,
    ]);

    res.status(200).send({ message: "about deleted successfully" });
  } catch (err) {
    console.error("An error occurred when deleting about from db ", err.stack);
    res.status(500).send({ error: err.stack });
  }
});
/***************  CUSTOMER TESTIMONIAL  **************************/

app.get("/customer_testimonial", async (req, res) => {
  try {
    let customer_testimonial = await db.query(
      "SELECT * FROM customer_testimonial"
    );
    res.status(200).json(customer_testimonial.rows);
  } catch (err) {
    console.error(
      "An Error occured when getting customer_testimonial from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//insert into customer_testimonial
app.post("/customer_testimonial", async (req, res) => {
  try {
    console.log(req.body.newCustomer_testimonial);
    const { name, comment, rating, title, avatar } =
      req.body.newCustomer_testimonial;

    const query =
      "INSERT INTO customer_testimonial (name, comment, rating, title, avatar) VALUES($1, $2, $3, $4, $5) RETURNING *;";
    const values = [name, comment, rating, title, avatar];

    const results = await db.query(query, values);
    return res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An error occurred when inserting customer_testimonials to db: ",
      err.stack
    );
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.put("/customer_testimonial/:id", async (req, res) => {
  try {
    console.log("data is ", req.body.newCustomer_testimonial);
    const id = parseInt(req.params.id);

    //check if id exist
    const customer_testimonialResult = await db.query(
      "SELECT * FROM customer_testimonial WHERE customer_testimonial_id =$1",
      [id]
    );
    if (customer_testimonialResult.rows.length === 0) {
      return res.status(404).send({ error: "customer_testimonial not found" });
    }
    const { name, comment, rating, title, avatar } =
      req.body.newCustomer_testimonial;

    const query =
      "UPDATE customer_testimonial SET name=$2, comment =$3, rating = $4, title = $5, avatar = $6 WHERE customer_testimonial_id = $1 RETURNING *;";
    const existingCustomer_testimonial = customer_testimonialResult.rows[0];
    const values = [
      id,
      name || existingCustomer_testimonial.name,
      comment || existingCustomer_testimonial.comment,
      rating || existingCustomer_testimonial.rating,
      title || existingCustomer_testimonial.title,
      avatar || existingCustomer_testimonial.avatar,
    ];
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An Error occured when updating customer_testimonial from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

// delete selected customer_testimonial ids
app.delete("/customer_testimonial", async (req, res) => {
  try {
    const ids = req.body.ids;

    if (!ids || ids.length === 0) {
      return res
        .status(400)
        .send({ error: "No customer_testimonial IDs provided" });
    }

    // Ensure all ids are numbers
    const idArray = ids.map((id) => parseInt(id, 10));

    // Check if the customer_testimonials exist
    const customer_testimonialResult = await db.query(
      "SELECT customer_testimonial_id FROM customer_testimonial WHERE customer_testimonial_id = ANY($1::int[])",
      [idArray]
    );

    if (customer_testimonialResult.rows.length === 0) {
      return res
        .status(404)
        .send({ error: "No customer_testimonial found with provided IDs" });
    }

    // Delete customer_testimonial
    await db.query(
      "DELETE FROM customer_testimonial WHERE customer_testimonial_id = ANY($1::int[])",
      [idArray]
    );

    res
      .status(200)
      .send({ message: "customer_testimonial deleted successfully" });
  } catch (err) {
    console.error(
      "An error occurred when deleting customer_testimonial from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

/***************  NEWSLETTER  **************************/

app.get("/newsletter", async (req, res) => {
  try {
    let newsletter = await db.query("SELECT * FROM newsletter");
    res.status(200).json(newsletter.rows);
  } catch (err) {
    console.error(
      "An Error occured when getting newsletter from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//insert into newsletter
app.post("/newsletter", async (req, res) => {
  try {
    console.log("Data from newsletter: ", req.body);
    const email = req.body.email;

    //check if email exist
    const emailExistResult = await db.query(
      "SELECT * FROM newsletter WHERE email = $1",
      [email]
    );
    if (emailExistResult.rows.length > 0) {
      return res.status(409).json({ error: "Email already exists." }); ///email exists
    } else {
      const query = "INSERT INTO newsletter (email) VALUES($1) RETURNING *;";
      const values = [email];

      const results = await db.query(query, values);
      res.status(200).json(results.rows[0]);
    }
  } catch (err) {
    console.error(
      "An Error occured when inserting newsletter to db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

app.put("/newsletter/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    //check if id exist
    const newsletterResult = await db.query(
      "SELECT * FROM newsletter WHERE newsletter_id =$1",
      [id]
    );
    if (newsletterResult.rows.length === 0) {
      return res.status(404).send({ error: "newsletter not found" });
    }
    const { email, is_disabled } = req.body.Newsletter;

    const query =
      "UPDATE newsletter SET email=$2, is_disabled =$3 WHERE newsletter_id = $1 RETURNING *;";
    const existingNewsletter = newsletterResult.rows[0];
    const values = [
      id,
      email || existingNewsletter.email,
      is_disabled || existingNewsletter.is_disabled,
    ];
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An Error occured when updating newsletter from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

// delete selected newsletter ids
app.delete("/newsletter", async (req, res) => {
  try {
    const ids = req.body.ids;

    if (!ids || ids.length === 0) {
      return res.status(400).send({ error: "No newsletter IDs provided" });
    }

    // Ensure all ids are numbers
    const idArray = ids.map((id) => parseInt(id, 10));

    // Check if the newsletters exist
    const newsletterResult = await db.query(
      "SELECT newsletter_id FROM newsletter WHERE newsletter_id = ANY($1::int[])",
      [idArray]
    );

    if (newsletterResult.rows.length === 0) {
      return res
        .status(404)
        .send({ error: "No newsletter found with provided IDs" });
    }

    // Delete newsletter
    await db.query(
      "DELETE FROM newsletter WHERE newsletter_id = ANY($1::int[])",
      [idArray]
    );

    res.status(200).send({ message: "newsletter deleted successfully" });
  } catch (err) {
    console.error(
      "An error occurred when deleting newsletter from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

/*****************DELIVERY DETAILS **********************/
//get delivery Id
app.get("/new-delivery_details_id", async (req, res) => {
  try {
    let deliveryDetails = await db.query("SELECT * FROM delivery_details");
    let deliveryId = 1;
    if (deliveryDetails.rows.length > 0) {
      deliveryId = deliveryDetails.rows.at(-1).delivery_id + 1;
    }
    res.json(deliveryId);
  } catch (err) {
    console.error(
      "An Error occured when getting delivery id from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//get delivery details
app.get("/delivery_details", async (req, res) => {
  try {
    let deliveryDetail = await db.query("SELECT * FROM delivery_details");
    res.status(200).json(deliveryDetail.rows);
  } catch (err) {
    console.error(
      "An Error occured when getting deliveryDetail from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//insert into delivery_detail
app.post("/delivery_details", async (req, res) => {
  try {
    //check if order_id is already present
    const orderResult = await db.query(
      "SELECT * FROM delivery_details WHERE order_id = $1",
      [req.body.newDeliveryDetails.order_id]
    );

    if (orderResult.rows.length > 0) {
      return res
        .status(409)
        .json({ error: "Order ID already exists in delivery_details." });
    }

    let {
      user_id,
      order_id,
      email,
      country,
      f_name,
      l_name,
      address,
      city,
      postal_code,
      phone_number,
      status,
    } = req.body.newDeliveryDetails;

    let query, values;

    query =
      "INSERT INTO delivery_details (user_id, order_id, email, country, f_name, l_name, address, city, postal_code, phone_number, status, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *;";
    values = [
      user_id,
      order_id,
      email,
      country,
      f_name,
      l_name,
      address,
      city,
      postal_code,
      phone_number,
      status,
    ];

    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An Error occured when inserting delivery details to db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//update delivery_detail
app.put("/delivery_details/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    console.log("log update ", id);

    //check if id exist
    const delivery_detailResult = await db.query(
      "SELECT * FROM delivery_details WHERE delivery_id =$1",
      [id]
    );
    if (delivery_detailResult.rows.length === 0) {
      return res.status(404).send({ error: "delivery_detail not found" });
    }

    let {
      delivery_id,
      user_id,
      order_id,
      email,
      country,
      f_name,
      l_name,
      address,
      city,
      postal_code,
      phone_number,
      status,
      description,
    } = req.body.deliveryDetailToUpdate;

    const query =
      "UPDATE delivery_details SET delivery_id=$1, user_id=$2, order_id = $3, email=$4, country=$5, f_name =$6, l_name =$7, address =$8, city =$9, postal_code =$10, phone_number =$11, status =$12, description = $13, updated_at=CURRENT_TIMESTAMP WHERE delivery_id=$1 RETURNING *;";
    const existingDelivery_detail = delivery_detailResult.rows[0];
    const values = [
      delivery_id || existingDelivery_detail.delivery_id,
      user_id || existingDelivery_detail.user_id,
      order_id || existingDelivery_detail.order_id,
      email || existingDelivery_detail.email,
      country || existingDelivery_detail.country,
      f_name || existingDelivery_detail.f_name,
      l_name || existingDelivery_detail.l_name,
      address || existingDelivery_detail.address,
      city || existingDelivery_detail.city,
      postal_code || existingDelivery_detail.postal_code,
      phone_number || existingDelivery_detail.phone_number,
      status || existingDelivery_detail.status,
      description || existingDelivery_detail.description,
    ];
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An Error occured when updating Delivery_detail from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

app.delete("/delivery_details", async (req, res) => {
  try {
    const ids = req.body.ids;

    if (!ids || ids.length === 0) {
      return res.status(400).send({ error: "No delivery_detail IDs provided" });
    }

    // Ensure all ids are numbers
    const idArray = ids.map((id) => parseInt(id, 10));

    // Check if the newsletters exist
    const delivery_detailResult = await db.query(
      "SELECT delivery_id FROM delivery_details WHERE delivery_id = ANY($1::int[])",
      [idArray]
    );

    if (delivery_detailResult.rows.length === 0) {
      return res
        .status(404)
        .send({ error: "No delivery_detail found with provided IDs" });
    }

    // Delete newsletter
    await db.query(
      "DELETE FROM delivery_details WHERE delivery_id = ANY($1::int[])",
      [idArray]
    );

    res.status(200).send({ message: "delivery_details deleted successfully" });
  } catch (err) {
    console.error(
      "An error occurred when deleting delivery_details from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

/***************  SLIDE SHOW  **************************/

app.get("/slide_show", async (req, res) => {
  try {
    let slide_show = await db.query("SELECT * FROM slide_show");
    res.status(200).json(slide_show.rows);
  } catch (err) {
    console.error(
      "An Error occured when getting slide_show from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

//insert into slide_show
app.post("/slide_show", async (req, res) => {
  try {
    const { title, description, image } = req.body.newSlide_show;

    const query =
      "INSERT INTO slide_show (title, description, image) VALUES($1, $2, $3) RETURNING *;";
    const values = [title, description, image];

    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An Error occured when inserting slide_show to db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

app.put("/slide_show/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    //check if id exist
    const slide_showResult = await db.query(
      "SELECT * FROM slide_show WHERE slide_show_id =$1",
      [id]
    );

    if (slide_showResult.rows.length === 0) {
      return res.status(404).send({ error: "slide_show not found" });
    }
    const { title, description, image } = req.body.newSlide_show;

    const query =
      "UPDATE slide_show SET title=$2, description =$3, image=$4 WHERE slide_show_id = $1 RETURNING *;";
    const existingSlideShow = slide_showResult.rows[0];
    const values = [
      id,
      title || existingSlideShow.title,
      description || existingSlideShow.description,
      image || existingSlideShow.image,
    ];
    const results = await db.query(query, values);
    res.status(200).json(results.rows[0]);
  } catch (err) {
    console.error(
      "An Error occured when updating slide_show from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

// delete selected slide_show ids
app.delete("/slide_show", async (req, res) => {
  try {
    const ids = req.body.ids;

    if (!ids || ids.length === 0) {
      return res.status(400).send({ error: "No slide_show IDs provided" });
    }

    // Ensure all ids are numbers
    const idArray = ids.map((id) => parseInt(id, 10));

    // Check if the slide_shows exist
    const slide_showResult = await db.query(
      "SELECT slide_show_id FROM slide_show WHERE slide_show_id = ANY($1::int[])",
      [idArray]
    );

    if (slide_showResult.rows.length === 0) {
      return res
        .status(404)
        .send({ error: "No slide_show found with provided IDs" });
    }

    // Delete slide_show
    await db.query(
      "DELETE FROM slide_show WHERE slide_show_id = ANY($1::int[])",
      [idArray]
    );

    res.status(200).send({ message: "slide_show deleted successfully" });
  } catch (err) {
    console.error(
      "An error occurred when deleting slide_show from db ",
      err.stack
    );
    res.status(500).send({ error: err.stack });
  }
});

/***********************UPLOAD IMAGES *************/
app.post("/upload", upload.array("files"), async (req, res) => {
  try {
    res.status(200).send("Files uploaded successfully");
  } catch (err) {
    res.status(500).send("Error uploading files", err);
  }
});

app.post("/upload-single", upload.single("file"), async (req, res) => {
  try {
    res.status(200).send("Files uploaded successfully");
  } catch (err) {
    res.status(500).send("Error uploading files", err);
  }
});
/*************  PASSPORT **********/
//passport log in
passport.use(
  new LocalStrategy(async function verify(username, password, cb) {
    try {
      const email = username;
      //const { email, password } = req.body;
      if (email === "" || password === "") {
        res.status(404).send({ error: "Enter Email and Password" });
      }

      const results = await db.query(
        "SELECT * FROM users WHERE email = $1 OR username = $1;",
        [email]
      );
      if (results.rows.length === 0) {
        //no username
        return cb("Email/ Password error");
      }
      const user = results.rows[0];
      //check if password matches
      bcrypt.compare(password, user.password, (err, result) => {
        if (err) {
          return cb(err);
        } else {
          if (result) {
            return cb(null, user);
          } else {
            return cb(null, false);
          }
        }
      });
    } catch (err) {
      return cb("Email/ Password error");
    }
  })
);

//jwt strategy for protected routes
const opts = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: jwtTokenSecret,
};
passport.use(
  new JwtStrategy(opts, async function (jwt_payload, done) {
    try {
      const result = await db.query("SELECT * FROM users WHERE user_id = $1", [
        jwt_payload.user_id,
      ]);
      const user = result.rows[0];

      if (user) {
        return done(null, user);
      } else {
        return done(null, false);
      }
    } catch (err) {
      return done(err, false);
    }
  })
);

passport.serializeUser((user, cb) => {
  cb(null, user);
});

passport.deserializeUser((user, cb) => {
  cb(null, user);
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
