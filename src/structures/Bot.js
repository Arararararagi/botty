/**
 * @file Bot Class file.
 * @author Ronin
 */
'use strict';

const EventEmitter = require('events').EventEmitter;
const Client = require('dicksword.js');
const Loader = require('./Loader');
const CommandLoader = require('./CommandLoader');
const FeatherLoader = require('./FeatherLoader');
const fork = require('child_process').fork;

/**
 * @class
 * @extends EventEmitter
 */
class Bot extends EventEmitter
{
  /**
   * Constructor for the Bot class
   * @param {Object} settings - Object that holds the settings for the Bot class.
   * @param {Object} settings.config - Config for the bot.
   * @param {Boolean} [settings.debug = false] - Decides if debug statements are logged, defaults to false.
   * @param {Boolean} [settings.shard = false] - Lets the bot know if it needs to shard.
   * @param {Boolean} [settings.forked = false] - If the bot is a forked process, this should be true
   */
  constructor(settings)
  {
    //inherit EventEmitter's constructor
    super();
    //settings
    this.config = settings.config;
    //optional settings
    this.debug = settings.debug || false;
    this.shard = settings.shard || false;
    this.forked = settings.forked || false;
    this.client = new Client({
      token: this.config.api.discord_token,
      autorun: true,
      cacheOfflineUsers: true
    });
    
    //other members
    this.startTime = new Date();
    this.manualKill = false;

    this.requires = {};
    //Let's do some wizardry to extend Object a little more in this instance ;)
    Object.defineProperty(this.requires, 'merge', {
      value: (obj2) =>
      {
        Object.keys(obj2).forEach((attrib) =>
        {
          this[attrib] = obj2[attrib];
        });

        return this;
      },
      enumerable: false
    });
    this.requires.config = this.config;
    
    let commandPromise = new CommandLoader(`${process.cwd()}/src/commands`).load({
      bot: this.client,
      info: this.requires,
      bObj: this
    });
    let modulePromise = new Loader(`${process.cwd()}/src/lib`).load({
      bot: this.client,
      info: this.requires,
      bObj: this
    });
    let featherPromise = new FeatherLoader(`${process.cwd()}/src/feathers`).load({
      bot: this.client,
      info: this.requires,
      bObj: this
    });
    Promise.all([commandPromise,modulePromise, featherPromise]).then((values) =>
    {
      this.requires.commands = values[0].commands;
      this.requires.privates = values[0].privates;
      //this.requires.merge(values[1]);
      this.requires = Object.assign(this.requires, values[1]);
      this.requires.feathers = values[2];
      this.emit('ready');
      //console.log(this);
    }).catch((err) =>
    {
      if(this.debug)
      {
        console.log(err);
      }
    });
    this.on('ready', () =>
    {
      console.log('Bot Backend Ready');
      this.start();
    });
  }
  /**
   * Let the bot know to start processing.
   * @function
   */
  start()
  {
    let bot = this.client;
    //let's not let the functions go crazy and bind themselves to this.client
    bot.on('ready', this.onReady.bind(this));
    bot.on('message', this.onMessage.bind(this));
    bot.on('disconnect', this.onDisconnect.bind(this));
    this.on('new_server', () =>
    {
      console.log('Joined new server');
    });
    bot.on('guildDelete', (server) =>
    {
      console.log(`Left ${server}`);
    });
  }
  /**
   * Action to take when the bot is ready
   * @function
   */
  onReady()
  {
    let bot = this.client;
    let utility = this.requires.utility;
    let config = this.config;
    console.log(`${bot.username} - (${bot.id})`);
    bot.setPresence({
      idle_since: null,
      game: {
        name : utility.filter(config.playing),
        type: 0
      }
    });
  }
  /**
   * Processes a message to see if it's a command or not. If it's a command, it will act.
   * @function
   * @param {String} user - Name of the user who sent the message.
   * @param {String} userID - userID of the user who sent the message.
   * @param {String} channelID - The channelID where the message was sent.
   * @param {String} message - The message that was sent.
   * @param {event} - The raw event caused by the message.
   */
  onMessage(message)
  {
    let bot = this.client;
    let commands = this.requires.commands;
    let privates = this.requires.privates;
    let utility = this.requires.utility;
    let db = this.requires.db;
    let details = {
      user: message.author.username,
      userID: message.author.id,
      channelID: message.channel_id,
      message: message.content,
      isDirectMessage: message.channel_id in bot.directMessages ? true : false,
      isCommandForm: utility.isCommandForm(message.content),
      isAdministrator: utility.isAdministrator(message.author.id)
    };
    
    // No need to continue if this isn't a command.
    if(!details.isCommandForm)
      return;
    
    if(!details.isDirectMessage)
    {
      details.serverID = utility.getServerID(details.channelID);
    }

    //separate the command from the rest of the string
    let cmd = utility.stripPrefix(details.message);
    let keyword = cmd.split(' ')[0];
    details.input = cmd.replace(keyword, '').trim();

    //split up the remaining into something similar to command line args
    details.args = cmd.split(' ');
    keyword = keyword.toLowerCase();
    
    //if the command exists, check the permissions.
    if(commands[keyword] && typeof commands[keyword].getAction() === 'function')
    {
      processCommand(keyword, details);
    }
    else
    {
      //didn't find command
      for(let index in commands)
      {
        if(commands[index] && typeof commands[index] === 'object' && commands[index].getAlias().indexOf(keyword) > -1)
        {
          processCommand(index, details);
        }
      }
    }
    
    function handleDisabled(details)
    {
      bot.sendMessage({
        to: details.channelID,
        embed: {
          title: 'Disabled',
          description: 'Looks like that command was disabled'
        }
      });
    }
    function processCommand(command, details)
    {
      if(commands[command].getPerm() === 'public')
      {
        commands[command].act(details);
      }
      else if(commands[command].getPerm() === 'private' && details.isAdministrator)
      {
        commands[command].act(details);
      }
    }
  }
  /**
   * Attempts to reconnect once a disconnect is fired, unless it was a manual disconnect.
   * @param {String} errMsg - Error message.
   * @param {String} code - Error code.
   */
  onDisconnect(errMsg, code)
  {
    let manualKill = this.manualKill;
    let bot = this.client;
    console.log(`ERROR ${code}: ${errMsg}`);
    if(!manualKill)
    {
      //reconnect
      bot.connect();
    }
    else
    {
      console.log('Kill command used.');
      process.exit(0);
    }
  }
  /**
   * Sets the manualKill variable to true and disconnects the bot
   */
  kill()
  {
    this.manualKill = true;
    this.client.disconnect();
  }
}

module.exports = Bot;
