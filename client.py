from pymongo import MongoClient
import logging

logging.basicConfig(level=logging.WARNING)

# --- DATABASE CONNECTION ---
def get_database():
    """Connect to MongoDB and return the database object."""
    try:
        CONNECTION_STRING = "mongodb://localhost:27017"
        client = MongoClient(CONNECTION_STRING)
        return client['annoythestreamer']
    except Exception as e:
        logging.error(f"Error while connecting to the database: {e}")

# --- INIT DATABASE ---
if __name__ == "__main__":
    dbname = get_database()
dbname = get_database()  # make available for import

# --- COLLECTIONS ---
col_facememe = dbname["facememe"]
col_normalmeme = dbname["normalmeme"]
col_ttsmeme = dbname["ttsmeme"]
col_chat = dbname["chat"]

# --- RESET FLAGS ---
col_facememe.update_many({}, {"$set": {"done": "yes"}})
col_normalmeme.update_many({}, {"$set": {"done": "yes"}})
col_chat.update_many({}, {"$set": {"done": "yes"}})

# --- INSERT FUNCTIONS ---
def add_facememe(collection):
    """Insert Face Meme."""
    try:
        col_facememe.insert_many([collection])
    except Exception as e:
        logging.error(f"Error while writing Face Meme data: {e}")

def add_normalmeme(collection):
    """Insert Normal Meme."""
    try:
        col_normalmeme.insert_many([collection])
    except Exception as e:
        logging.error(f"Error while writing Normal Meme data: {e}")

def add_ttsmeme(collection):
    """Insert TTS Meme."""
    try:
        col_ttsmeme.insert_one(collection)
    except Exception as e:
        logging.error(f"Error while writing TTS data: {e}")

# --- FETCH FUNCTIONS ---
def get_next_ttsmeme():
    """Get next TTS meme not done."""
    try:
        tts = col_ttsmeme.find_one({"done": "no"}, sort=[("_id", 1)])
        if tts:
            tts["_id"] = str(tts["_id"])
        return tts
    except Exception as e:
        logging.error(f"Error fetching next TTS: {e}")

def get_last_meme(collection):
    """Get last meme from a collection not done."""
    try:
        last_meme = collection.find_one({"done": "no"}, sort=[("_id", -1)])
        if last_meme:
            last_meme["_id"] = str(last_meme["_id"])
        return last_meme
    except Exception as e:
        logging.error(f"Error while fetching last meme: {e}")

# --- WRAPPERS FOR SPECIFIC COLLECTIONS ---
def last_facememe():
    """Last Face Meme."""
    return get_last_meme(col_facememe)

def last_normalmeme():
    """Last Normal Meme."""
    return get_last_meme(col_normalmeme)

# --- CHAT MESSAGES ---
def last_chat_messages(limit=50):
    """Get last `limit` chat messages, oldest to newest."""
    try:
        msgs = list(col_chat.find().sort("timestamp", -1).limit(limit))
        for m in msgs:
            m["_id"] = str(m["_id"])
        msgs.reverse()
        return msgs
    except Exception as e:
        logging.error(f"Error fetching last chat messages: {e}")
        return []

