import express from "express";

const app = express();
app.get("/", (_req, res) => res.send("status-api"));
app.get("/status", (_req, res) => res.json({ ok: true }));
