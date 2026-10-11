const session = require("express-session");

class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.getStatement = db.prepare("SELECT sess, expires FROM sessions WHERE sid = ?");
    this.setStatement = db.prepare(`
      INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
    `);
    this.destroyStatement = db.prepare("DELETE FROM sessions WHERE sid = ?");
    this.touchStatement = db.prepare("UPDATE sessions SET expires = ? WHERE sid = ?");
    this.pruneStatement = db.prepare("DELETE FROM sessions WHERE expires <= ?");
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid);
      if (!row) return callback(null, null);
      if (row.expires <= Date.now()) {
        this.destroyStatement.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 43200000;
      this.setStatement.run(sid, JSON.stringify(sess), expires);
      this.pruneStatement.run(Date.now());
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 43200000;
      this.touchStatement.run(expires, sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

module.exports = { SQLiteSessionStore };
