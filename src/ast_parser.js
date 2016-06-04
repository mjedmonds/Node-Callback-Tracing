const fs = require('fs');
const esprima = require('esprima');
const walkAST = require('esprima-walk');
const util = require('./util');

var emits = [];
var listeners = [];
var emit_triggers = new Array();
var filename;

/* ---- CLASSES ---- */

// Emit class, represents and emit and a corresponding caller
//function Emit(event, caller, emit_src_info, caller_src_info) {
function Emit(event, caller, emit_loc, blk_stmt_loc, filename)
{
  this.event = event; // event being triggered
  this.caller = caller; //
  this.emit_loc = emit_loc; // loc of emit
  this.blk_stmt_loc = blk_stmt_loc; // loc of event's block statement ending
  this.filename = filename;
}

// Listener class, represents an event and a corresponding callback
// XXX: callback_name_src is the same line number as the on()/once(). It should be the line up of the actual callback function?
function Listener(event, callback, once, listener_loc, blk_stmt_loc, filename)
{
  this.event = event;
  this.callback = callback;
  this.once = once;
  this.listener_loc = listener_loc; // loc of listener
  this.blk_stmt_loc = blk_stmt_loc; // loc of the block statement
  this.filename = filename;
}

// e_loc can be an emit or event loc
function LogItem(e_loc, blk_loc, log_str, triggers, filename)
{
  this.e_loc = e_loc;
  this.blk_loc = blk_loc;
  this.log_str = log_str;
  this.triggers = triggers; //functions triggered by this event (only valid for
  this.filename = filename;
}

// represents a block statement loc. Can be at the root of the program (e.g. no higher block statement exists
// or can be at an arrow function without braces (another special case for how to insert log).
// possible values: loc = loc object/null, root = true/false, arrow = true/false
// This object would be a union in other languages, so only one item should be set to the first possible value at a time
function BlkStmtLoc(loc, root, arrow)
{
  this.loc = loc;
  this.root = root;
  this.arrow = arrow;
}

function LogCollection(logs, triggers)
{
  this.logs = logs;
  this.triggers = triggers;
}

/* ---------------------------------------------------------------- */

module.exports = {
  collect_loggings: function (src, fname)
  {
    // clear previous file's data
    emits = [];
    listeners = [];
    emit_triggers = new Array();
    filename = fname;

    var ast = esprima.parse(src, {
      loc: true
    });

    walkAST.walkAddParent(ast, ast_walker);

    collect_emit_triggers();
    var listener_logs = log_listeners();
    var emit_logs = log_emits();
    var logs = emit_logs.concat(listener_logs)
    logs.sort(compare_logs); // sort the logs by e_loc's
    //var log_collection = new LogCollection(logs, trigger_logs);
    return logs;
  }
};

// finds an the event emitting by an emit() node in the AST
function find_emit_event_name(parent)
{
  if (parent.type == "CallExpression")
  {
    //console.log("found event: " + parent.arguments[0].value);
    return parent.arguments[0].value;
  }
  else
  {
    return find_emit_event_name(parent.parent);
  }
}

// finds the function name of a calling function
function find_function_name(parent)
{
  if (parent == null)
  { // anonymous function case
    // console.log("found function name: anon" + unknown_count);
    return null;
  }
  else if (parent.type == 'Property' && parent.hasOwnProperty('key') && parent.key.hasOwnProperty('name'))
  { // handle special case of anonymous function that is a value in key/value pair
    return parent.key.name;
  }
  else if (!parent.id)
  { // otherwise if parent is null, recurse down parent looking for the function
    // console.log("found null parent.id, parent.type: " + parent.type);
    return find_function_name(parent.parent);
  }
  else
  {
    // console.log("found function name: " + parent.id.name)
    return parent.id.name;
  }
}

// finds the calling function of this AST node
function find_emit_calling_function(node)
{
  // global emit will not have a parent, "Program" is the parent in the AST
  if (!node.hasOwnProperty('parent'))
  { // if the node doesn't have a parent, we are at the end of the AST
    return 'Program';
  }

  var parent = node.parent;

  if (parent.hasOwnProperty('type') && (parent.type == 'FunctionExpression' || parent.type == 'FunctionDeclaration' || parent.type == 'ArrowFunctionExpression'))
  { // if we find a function, look for its name
    //console.log("found function for emit");
    return find_function_name(parent);
  }
  else
  { // otherwise recurse up the parent
    return find_emit_calling_function(parent);
  }
}

// returns the end loc of the next enclosing block statement
function find_enclosing_blk_stmt(node)
{
  if (node.hasOwnProperty('type') && node.type == 'BlockStatement')
  {
    return new BlkStmtLoc(node.loc, false, false);
  }
  else if (node.type == 'Program')
  { // if we are at the root of the AST, don't recurse
    return new BlkStmtLoc(null, true, false);
  }
  else if (node.type == 'ArrowFunctionExpression')
  { // special case where we hit an arrow function before a block statement 
    return new BlkStmtLoc(null, false, true);
  }
  else
  { // recurse down the parent
    return find_enclosing_blk_stmt(node.parent);
  }
}

// determines the start and end loc of the corresponding CallExpression of an emit()
function find_call_expr_loc(node)
{
  if (node.hasOwnProperty('type') && node.type == 'CallExpression')
  {
    return node.loc;
  }
  else
  {
    return find_call_expr_loc(node.parent)
  }
}

// collects emitting node information (event and caller) and registers them into the emits global var
function collect_emits(node)
{
  if (node.type == 'Identifier' && node.hasOwnProperty('name') && node.name == 'emit')
  { // found an emit
    var emit_event = find_emit_event_name(node.parent);            // emit_ret[0] = event name, emit_ret[1] = loc of emit()
    var calling_func = find_emit_calling_function(node.parent);  // calling_func[0] = name of calling func, calling_func[1] = loc of calling function
    var blk_stmt_loc = find_enclosing_blk_stmt(node.parent);
    var emit_loc = find_call_expr_loc(node.parent);

    emits.push(new Emit(emit_event, calling_func, emit_loc, blk_stmt_loc, filename));
    return true;
  }
  else
  { // didn't find an emit
    return false;
  }
}

// returns the function name of a callback (or null if unknown)
function find_callback_function(callback)
{
  if (callback.name != null)
  {
    return callback.name;
  }
  else
  {
    return null;
  }
}

// finds all on() and once() calls and registers them into the listeners var
function collect_listeners(node)
{
  if (node.type == "ExpressionStatement" && node.expression.type == "CallExpression" && node.expression.arguments.length == 2)
  {
    var once;
    if (node.expression.callee.property.name == "on")
    {
      once = false;
    }
    else if (node.expression.callee.property.name == "once")
    {
      once = true;
    }
    else
    { // return if this isn't an on() or once()
      return;
    }
    //console.log("found on()");
    var event = node.expression.arguments[0];
    var callback_func = find_callback_function(node.expression.arguments[1]);
    var blk_stmt_loc = find_enclosing_blk_stmt(node.parent);
    var calling_func_loc = node.loc;          // already at the CallExpression/ExpressionStatement in the AST
    if (callback_func == null){
      callback_func = 'anon_' + node.loc.start.line;
    }
    listeners.push(new Listener(event.value, callback_func, once, calling_func_loc, blk_stmt_loc, filename));
  }
}

function collect_emit_triggers()
{
  var event, callback;
  for (var i = 0; i < listeners.length; i++)
  {
    event = listeners[i].event;
    callback = listeners[i].callback;
    if (!(listeners[i].event in emit_triggers))
    {
      emit_triggers.push(event);
      emit_triggers[event] = [];
    }
    emit_triggers[event].push(callback);
  }
}

// main walking function to traverse each AST node
function ast_walker(node)
{
  var emit_found = collect_emits(node);
  // only look for listeners if we didn't find an emit, no reason to look for listeners if we found an emit
  if (!emit_found)
  {
    collect_listeners(node);
  }
  // console.log(node.type)
}

// compares two LogItems by looking at their e_loc's, used to sort array of log inserts
function compare_logs(log_a, log_b)
{
  return util.compare_loc(log_a.e_loc.start, log_b.e_loc.start);
}

function print_emits()
{
  for (var i = 0; i < emits.length; i++)
  {
    console.log(emits[i].caller + " emitting event " + emits[i].event);
  }
}

function print_listeners()
{
  for (var i = 0; i < listeners.length; i++)
  {
    if (listeners[i].once)
    {
      console.log(listeners[i].event + " triggers callback " + listeners[i].callback + " once");
    }
    else
    {
      console.log(listeners[i].event + " triggers callback " + listeners[i].callback);
    }
  }
}

function log_emits()
{
  var emit_logs = [];
  for (var i = 0; i < emits.length; i++)
  {
    emit_logs.push(new LogItem(emits[i].emit_loc, emits[i].blk_stmt_loc,
      'lumberjack.info(\'function \\\'' + emits[i].caller + '\\\' emitting event \\\'' + emits[i].event + '\\\'\');',
      log_triggers(emits[i].event, emits[i].caller), emits[i].filename));
  }
  return emit_logs;
}

function log_listeners()
{
  var listener_logs = [];
  for (var i = 0; i < listeners.length; i++)
  {
    if (listeners[i].once)
    {
      listener_logs.push(new LogItem(listeners[i].listener_loc, listeners[i].blk_stmt_loc,
        'lumberjack.info(\'\\\'' + listeners[i].event + '\\\' triggers callback \\\'' + listeners[i].callback + '\\\' once' + '\');',
        [], listeners[i].filename));
    }
    else
    {
      listener_logs.push(new LogItem(listeners[i].listener_loc, listeners[i].blk_stmt_loc,
        'lumberjack.info(\'\\\'' + listeners[i].event + '\\\' triggers callback \\\'' + listeners[i].callback + '\\\'\');',
        [], listeners[i].filename));
    }
  }
  return listener_logs;
}

function log_triggers(event, caller)
{
  var triggers = [];
  for(var i = 0; event in emit_triggers && i < emit_triggers[event].length; i++){
    triggers.push('lumberjack.info(\t\'\\\'' + caller + '\\\' -> \\\'' + emit_triggers[event][i] + '\\\'\');');
  }
  return triggers;
}