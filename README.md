# AnnoyTheStreamer

## Description

Python Flask web application allowing viewers to use a soundboard or interact with the stream using one of three forms.
One of them sends top and bottom text to be diplayed on top of the streamer's camera to make it look like a meme.
The second one allows for passing top and bottom text along with an image to create a full meme.
The last one creates a text-to-speech message to be played and displayed during the stream.
Last part of the app is a live chat with emojis and tagging users with @ sign.
All the memes and chat messages will be queued in the database and displayed in order of being submitted.
TTSMessages start auto-deleting the oldest one after reaching a treshhold of 25 files.

## Additional information

The app as-is lets you set the server on your machine, but to share it you need to share your public IP. It is possible to bypass this restriction by aquiring a domain name and using other app, for example Caddy.

## Requirements

- For library requirements refer to requirements.txt
- MongoDB Community Server
- OBS Studio
- [xObsBrowserAutoRefresh](https://github.com/YorVeX/xObsBrowserAutoRefresh)
- MongoDBCompass (optional)
- Caddy (optional)

## Instructions
 
1. Install the following
    - required libraries from requirements.txt.
    - MongoDB Community Server
    - OBS Studio
    - [xObsBrowserAutoRefresh](https://github.com/YorVeX/xObsBrowserAutoRefresh)

2. Run MongoDB
    - add new connection
    - just set the name
        - if you want to edit connection string make sure to copy the URI and update the following line in the client.py file
        ```
        CONNECTION_STRING = "mongodb://localhost:27017"
        ```
    - create a new database and name it "annoythestreamer"
        - if you want to use a differnt name, be sure to update the following line in the client.py file
        ```
        return client['annoythestreamer']
        ```

3. Be sure to open port 2137 (also 80 and 443 if you plan on using Caddy) on both your Windows firewall and router
    - If you don't want to open the port, update the following line in the annoythestreamer.py file and steps 5.2, 5.8, 6, 7 to an open port of your choosing
    ```
    app.run(host='0.0.0.0', debug=True, port=2137)    
    ```

4. Open the console in the application directory or navigate to it
    - run the command
    ```
    python annoythestreamer.py
    ```
    - to stop the server click Ctrl+C in the console

5. (Optional) If you plan on using Caddy, replace the uncommented __main__ portion in annoythestreamer.py and replace it with the commented part, then configure your Caddyfile properly and add Caddy.exe and Caddyfile paths to caddy.py

6. Run OBS Studio
    - add new source, choose "Browser" and name it "Face Meme"
    - URL: http://localhost:80/FaceMeme
    - position it on top of your camera
    - add new source, choose "Browser" and name it "Normal Meme"
    - URL: http://localhost:80/NormalMeme
    - position it wherever you want the meme to be displayed
    - add new source, choose "Browser" and name it "Source Meme"
    - URL: http://localhost:80/SoundMeme
    - check "Control audio via OBS"
    - you might need to interact with the site if OBS doesn't do that itself, to do that right press on TTS Meme on the sources list and choose "Interact", then interact with the page
    - push it behind the scene
    - add new source, choose "Browser" and name it "TTS Meme"
    - URL: http://localhost:80/TTSMeme
    - check "Control audio via OBS"
    - you might need to interact with the site if OBS doesn't do that itself, to do that right press on TTS Meme on the sources list and choose "Interact", then interact with the page
    - position it wherever you want the TTS to be displayed
    - add new source, choose "Browser" and name it "Chat"
    - URL: http://localhost:80/ChatCapture
    - position it wherever you want the chat to be displayed

7. Add your own sounds for the soundboard
    - put the sounds into /static/sounds/soundboard
    - make sure the sounds have no spaces and special characters
    - edit templates/SoundMeme.html under this section by replacing for example sound1 with the name of your file (without extension)
    ```
    <!-- Configure your buttons and sounds, data-sound should be the same as filename without extension. -->
    <button class="btn btn-secondary sound-btn" data-sound="sound1">Sound 1</button>
    <button class="btn btn-secondary sound-btn" data-sound="sound2">Sound 2</button>
    <button class="btn btn-secondary sound-btn" data-sound="sound3">Sound 3</button>
    <button class="btn btn-secondary sound-btn" data-sound="sound4">Sound 4</button>
    <button class="btn btn-secondary sound-btn" data-sound="sound5">Sound 5</button>
    <button class="btn btn-secondary sound-btn" data-sound="sound6">Sound 6</button>
    <button class="btn btn-secondary sound-btn" data-sound="sound7">Sound 7</button>
    <button class="btn btn-secondary sound-btn" data-sound="sound8">Sound 8</button>
    <button class="btn btn-secondary sound-btn" data-sound="sound9">Sound 9</button>
    <button class="btn btn-secondary sound-btn" data-sound="sound10">Sound 10</button>
    <button class="btn btn-secondary sound-btn" data-sound="sound11">Sound 11</button>
    <button class="btn btn-secondary sound-btn" data-sound="sound12">Sound 12</button>
    ```

8. Add your own emojis
    - put the emojis into /static/img/emoji
    - make sure the names have no spaces and special characters
    - after restarting the server typing :emojiname: will send it to the chat (without extensions)

9. Open http://localhost:80 in your browser
    - choose whether you want to use the "Face Meme", "Normal Meme",  form
    - fill in the form and click "submit"
    - to send the photo you need to input an URL

10. To share the form with other people you have to replace "localhost" in the address with either your local IP address (for people using your WiFi network) or public IP address (for people not using your WiFi network)
    (WARNING: Never share your public address with people you don't trust!)
    - to check your local IP address open the command prompt, type "ipconfig" and look for "IPv4 Address"
    - to check your public IP address visit https://www.whatismyip.com/
    - suggestion: using Caddy as a server with https
