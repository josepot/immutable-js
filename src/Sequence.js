/**
 *  Copyright (c) 2014, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

/* Sequence has implicit lazy dependencies */
import "TrieUtils"
import "invariant"
import "Symbol"
import "Hash"
/* global is, Map, OrderedMap, Vector, Set, arrCopy, NOT_SET, invariant,
          ITERATOR, hash, HASH_MAX_VAL */
/* exported Sequence, IndexedSequence, SequenceIterator, iteratorMapper */


class Sequence {

  constructor(value) {
    return Sequence.from(
      arguments.length === 1 ? value : Array.prototype.slice.call(arguments)
    );
  }

  static from(value) {
    if (value instanceof Sequence) {
      return value;
    }
    if (!Array.isArray(value)) {
      if (value && value.constructor === Object) {
        return new ObjectSequence(value);
      }
      value = [value];
    }
    return new ArraySequence(value);
  }

  toString() {
    return this.__toString('Seq {', '}');
  }

  __toString(head, tail) {
    if (this.length === 0) {
      return head + tail;
    }
    return head + ' ' + this.map(this.__toStringMapper).join(', ') + ' ' + tail;
  }

  __toStringMapper(v, k) {
    return k + ': ' + quoteString(v);
  }

  toJS() {
    return this.map(value => value instanceof Sequence ? value.toJS() : value).__toJS();
  }

  toArray() {
    assertNotInfinite(this.length);
    var array = new Array(this.length || 0);
    this.valueSeq().forEach((v, i) => { array[i] = v; });
    return array;
  }

  toObject() {
    assertNotInfinite(this.length);
    var object = {};
    this.forEach((v, k) => { object[k] = v; });
    return object;
  }

  toVector() {
    // Use Late Binding here to solve the circular dependency.
    assertNotInfinite(this.length);
    return Vector.from(this);
  }

  toMap() {
    // Use Late Binding here to solve the circular dependency.
    assertNotInfinite(this.length);
    return Map.from(this);
  }

  toOrderedMap() {
    // Use Late Binding here to solve the circular dependency.
    assertNotInfinite(this.length);
    return OrderedMap.from(this);
  }

  toSet() {
    // Use Late Binding here to solve the circular dependency.
    assertNotInfinite(this.length);
    return Set.from(this);
  }

  toKeyedSeq() {
    return this;
  }

  hashCode() {
    return this.__hash || (this.__hash =
      this.length === Infinity ? 0 : this.reduce(
        (h, v, k) => (h + (hash(v) ^ (v === k ? 0 : hash(k)))) & HASH_MAX_VAL, 0
    ));
  }

  equals(other) {
    if (this === other) {
      return true;
    }
    if (!(other instanceof Sequence)) {
      return false;
    }
    if (this.length != null && other.length != null) {
      if (this.length !== other.length) {
        return false;
      }
      if (this.length === 0 && other.length === 0) {
        return true;
      }
    }
    if (this.__hash != null && other.__hash != null &&
        this.__hash !== other.__hash) {
      return false;
    }
    return this.__deepEquals(other);
  }

  __deepEquals(other) {
    var entries = this.cacheResult().entrySeq().toArray();
    var iterations = 0;
    return other.every((v, k) => {
      var entry = entries[iterations++];
      return is(k, entry[0]) && is(v, entry[1]);
    });
  }

  join(separator) {
    separator = separator !== undefined ? '' + separator : ',';
    var string = '';
    var isFirst = true;
    this.forEach((v, k) => {
      if (isFirst) {
        isFirst = false;
        string += (v != null ? v : '');
      } else {
        string += separator + (v != null ? v : '');
      }
    });
    return string;
  }

  count(predicate, thisArg) {
    if (!predicate) {
      if (this.length == null) {
        this.length = this.forEach(returnTrue);
      }
      return this.length;
    }
    return this.filter(predicate, thisArg).count();
  }

  countBy(mapper, context) {
    var seq = this;
    return OrderedMap.empty().withMutations(map => {
      seq.forEach((value, key, collection) => {
        map.update(mapper(value, key, collection), increment);
      });
    });
  }

  concat(...values) {
    var sequences = [this].concat(values.map(value => Sequence(value)));
    var concatSequence = this.__makeSequence();
    concatSequence.length = sequences.reduce(
      (sum, seq) => sum != null && seq.length != null ? sum + seq.length : undefined, 0
    );
    concatSequence.__iterateUncached = (fn, reverse) => {
      var iterations = 0;
      var stoppedIteration;
      var lastIndex = sequences.length - 1;
      for (var ii = 0; ii <= lastIndex && !stoppedIteration; ii++) {
        var seq = sequences[reverse ? lastIndex - ii : ii];
        iterations += seq.__iterate((v, k, c) => {
          if (fn(v, k, c) === false) {
            stoppedIteration = true;
            return false;
          }
        }, reverse);
      }
      return iterations;
    };
    return concatSequence;
  }

  reverse() {
    var sequence = this;
    var reversedSequence = sequence.__makeSequence();
    reversedSequence.reverse = () => sequence;
    reversedSequence.length = sequence.length;
    reversedSequence.__iterateUncached = (fn, reverse) => sequence.__iterate(fn, !reverse);
    return reversedSequence;
  }

  keySeq() {
    return this.flip().valueSeq();
  }

  valueSeq() {
    // valueSeq() always returns an IndexedSequence.
    var sequence = this;
    var valuesSequence = makeIndexedSequence(sequence);
    valuesSequence.length = sequence.length;
    valuesSequence.valueSeq = returnThis;
    valuesSequence.__iterateUncached = function (fn, reverse, flipIndices) {
      if (flipIndices && this.length == null) {
        return this.cacheResult().__iterate(fn, reverse, flipIndices);
      }
      var iterations = 0;
      var predicate;
      if (flipIndices) {
        iterations = this.length - 1;
        predicate = (v, k, c) => fn(v, iterations--, c) !== false;
      } else {
        predicate = (v, k, c) => fn(v, iterations++, c) !== false;
      }
      sequence.__iterate(predicate, reverse); // intentionally do not pass flipIndices
      return flipIndices ? this.length : iterations;
    }
    return valuesSequence;
  }

  entrySeq() {
    var sequence = this;
    if (sequence._cache) {
      // We cache as an entries array, so we can just return the cache!
      return Sequence(sequence._cache);
    }
    var entriesSequence = sequence.map(entryMapper).valueSeq();
    entriesSequence.fromEntries = () => sequence;
    return entriesSequence;
  }

  forEach(sideEffect, thisArg) {
    return this.__iterate(thisArg ? sideEffect.bind(thisArg) : sideEffect);
  }

  reduce(reducer, initialReduction, thisArg) {
    var reduction;
    var useFirst;
    if (arguments.length < 2) {
      useFirst = true;
    } else {
      reduction = initialReduction;
    }
    this.forEach((v, k, c) => {
      if (useFirst) {
        useFirst = false;
        reduction = v;
      } else {
        reduction = reducer.call(thisArg, reduction, v, k, c);
      }
    });
    return reduction;
  }

  reduceRight(reducer, initialReduction, thisArg) {
    var reversed = this.toKeyedSeq().reverse();
    return reversed.reduce.apply(reversed, arguments);
  }

  every(predicate, thisArg) {
    var returnValue = true;
    this.forEach((v, k, c) => {
      if (!predicate.call(thisArg, v, k, c)) {
        returnValue = false;
        return false;
      }
    });
    return returnValue;
  }

  some(predicate, thisArg) {
    return !this.every(not(predicate), thisArg);
  }

  first() {
    return this.find(returnTrue);
  }

  last() {
    return this.findLast(returnTrue);
  }

  rest() {
    return this.slice(1);
  }

  butLast() {
    return this.slice(0, -1);
  }

  has(searchKey) {
    return this.get(searchKey, NOT_SET) !== NOT_SET;
  }

  get(searchKey, notSetValue) {
    return this.find((_, key) => is(key, searchKey), null, notSetValue);
  }

  getIn(searchKeyPath, notSetValue) {
    if (!searchKeyPath || searchKeyPath.length === 0) {
      return this;
    }
    return getInDeepSequence(this, searchKeyPath, notSetValue, 0);
  }

  contains(searchValue) {
    return this.find(value => is(value, searchValue), null, NOT_SET) !== NOT_SET;
  }

  find(predicate, thisArg, notSetValue) {
    var foundValue = notSetValue;
    this.forEach((v, k, c) => {
      if (predicate.call(thisArg, v, k, c)) {
        foundValue = v;
        return false;
      }
    });
    return foundValue;
  }

  findKey(predicate, thisArg) {
    var foundKey;
    this.forEach((v, k, c) => {
      if (predicate.call(thisArg, v, k, c)) {
        foundKey = k;
        return false;
      }
    });
    return foundKey;
  }

  findLast(predicate, thisArg, notSetValue) {
    return this.toKeyedSeq().reverse().find(predicate, thisArg, notSetValue);
  }

  findLastKey(predicate, thisArg) {
    return this.toKeyedSeq().reverse().findKey(predicate, thisArg);
  }

  flip() {
    // flip() always returns a non-indexed Sequence.
    var sequence = this;
    var flipSequence = makeSequence();
    flipSequence.length = sequence.length;
    flipSequence.flip = () => sequence;
    flipSequence.__iterateUncached = function (fn, reverse) {
      return sequence.__iterate((v, k) => fn(k, v, this) !== false, reverse);
    }
    return flipSequence;
  }

  map(mapper, thisArg) {
    var sequence = this;
    var mappedSequence = sequence.__makeSequence();
    mappedSequence.length = sequence.length;
    mappedSequence.__iterateUncached = function (fn, reverse) {
      return sequence.__iterate(
        (v, k, c) => fn(mapper.call(thisArg, v, k, c), k, this) !== false,
        reverse
      );
    }
    return mappedSequence;
  }

  mapKeys(mapper, thisArg) {
    var sequence = this;
    var mappedSequence = sequence.__makeSequence();
    mappedSequence.length = sequence.length;
    mappedSequence.__iterateUncached = function (fn, reverse) {
      return sequence.__iterate(
        (v, k, c) => fn(v, mapper.call(thisArg, k, v, c), this) !== false,
        reverse
      );
    }
    return mappedSequence;
  }

  filter(predicate, thisArg) {
    return filterFactory(this, predicate, thisArg, true);
  }

  slice(begin, end) {
    if (wholeSlice(begin, end, this.length)) {
      return this;
    }
    var resolvedBegin = resolveBegin(begin, this.length);
    var resolvedEnd = resolveEnd(end, this.length);
    // begin or end will be NaN if they were provided as negative numbers and
    // this sequence's length is unknown. In that case, convert it to an
    // IndexedSequence by getting entrySeq() and convert back to a sequence with
    // fromEntrySeq(). IndexedSequence.slice will appropriately handle this case.
    if (resolvedBegin !== resolvedBegin || resolvedEnd !== resolvedEnd) {
      return this.entrySeq().slice(begin, end).fromEntrySeq();
    }
    var skipped = resolvedBegin === 0 ? this : this.skip(resolvedBegin);
    return resolvedEnd == null || resolvedEnd === this.length ?
      skipped : skipped.take(resolvedEnd - resolvedBegin);
  }

  take(amount) {
    var sequence = this;
    if (amount > sequence.length) {
      return sequence;
    }
    var takeSequence = sequence.__makeSequence();
    takeSequence.__iterateUncached = function(fn, reverse, flipIndices) {
      if (reverse) {
        // TODO: can we do a better job of this?
        return this.cacheResult().__iterate(fn, reverse, flipIndices);
      }
      var iterations = 0;
      sequence.__iterate((v, k) => {
        if (iterations < amount && fn(v, k, this) !== false) {
          iterations++;
        } else {
          return false;
        }
      }, reverse, flipIndices);
      return iterations;
    };
    takeSequence.length = this.length && Math.min(this.length, amount);
    return takeSequence;
  }

  takeLast(amount) {
    return this.reverse().take(amount).reverse();
  }

  takeWhile(predicate, thisArg) {
    var sequence = this;
    var takeSequence = sequence.__makeSequence();
    takeSequence.__iterateUncached = function(fn, reverse, flipIndices) {
      if (reverse) {
        // TODO: can we do a better job of this?
        return this.cacheResult().__iterate(fn, reverse, flipIndices);
      }
      var iterations = 0;
      sequence.__iterate((v, k, c) => {
        if (predicate.call(thisArg, v, k, c) && fn(v, k, this) !== false) {
          iterations++;
        } else {
          return false;
        }
      }, reverse, flipIndices);
      return iterations;
    };
    return takeSequence;
  }

  takeUntil(predicate, thisArg) {
    return this.takeWhile(not(predicate), thisArg);
  }

  skip(amount) {
    var sequence = this;
    if (amount === 0) {
      return sequence;
    }
    var skipSequence = sequence.__makeSequence();
    skipSequence.__iterateUncached = function (fn, reverse, flipIndices) {
      if (reverse) {
        // TODO: can we do a better job of this?
        return this.cacheResult().__iterate(fn, reverse, flipIndices);
      }
      var isSkipping = true;
      var iterations = 0;
      var skipped = 0;
      sequence.__iterate((v, k) => {
        if (!(isSkipping && (isSkipping = skipped++ < amount))) {
          if (fn(v, k, this) !== false) {
            iterations++;
          } else {
            return false;
          }
        }
      }, reverse, flipIndices);
      return iterations;
    };
    skipSequence.length = this.length && Math.max(0, this.length - amount);
    return skipSequence;
  }

  skipLast(amount) {
    return this.reverse().skip(amount).reverse();
  }

  skipWhile(predicate, thisArg) {
    var sequence = this;
    var skipSequence = sequence.__makeSequence();
    skipSequence.__iterateUncached = function (fn, reverse, flipIndices) {
      if (reverse) {
        // TODO: can we do a better job of this?
        return this.cacheResult().__iterate(fn, reverse, flipIndices);
      }
      var isSkipping = true;
      var iterations = 0;
      sequence.__iterate((v, k, c) => {
        if (!(isSkipping && (isSkipping = predicate.call(thisArg, v, k, c)))) {
          if (fn(v, k, this) !== false) {
            iterations++;
          } else {
            return false;
          }
        }
      }, reverse, flipIndices);
      return iterations;
    };
    return skipSequence;
  }

  skipUntil(predicate, thisArg) {
    return this.skipWhile(not(predicate), thisArg);
  }

  groupBy(mapper, context) {
    return groupByFactory(this, mapper, context, true);
  }

  sort(comparator) {
    return this.sortBy(valueMapper, comparator);
  }

  sortBy(mapper, comparator) {
    comparator = comparator || defaultComparator;
    var seq = this;
    return Sequence(this.entrySeq().entrySeq().toArray().sort(
      (a, b) => comparator(
        mapper(a[1][1], a[1][0], seq),
        mapper(b[1][1], b[1][0], seq)
      ) || a[0] - b[0]
    )).fromEntrySeq().valueSeq().fromEntrySeq();
  }

  cacheResult() {
    if (!this._cache && this.__iterateUncached) {
      assertNotInfinite(this.length);
      this._cache = this.entrySeq().toArray();
      if (this.length == null) {
        this.length = this._cache.length;
      }
    }
    return this;
  }

  // abstract __iterateUncached(fn, reverse)

  __iterate(fn, reverse, flipIndices) {
    if (!this._cache) {
      return this.__iterateUncached(fn, reverse, flipIndices);
    }
    var maxIndex = this.length - 1;
    var cache = this._cache;
    var c = this;
    if (reverse) {
      for (var ii = cache.length - 1; ii >= 0; ii--) {
        var revEntry = cache[ii];
        if (fn(revEntry[1], flipIndices ? revEntry[0] : maxIndex - revEntry[0], c) === false) {
          break;
        }
      }
    } else {
      cache.every(flipIndices ?
        entry => fn(entry[1], maxIndex - entry[0], c) !== false :
        entry => fn(entry[1], entry[0], c) !== false
      );
    }
    return this.length;
  }

  __makeSequence() {
    return makeSequence();
  }
}

var SequencePrototype = Sequence.prototype
SequencePrototype.toJSON = SequencePrototype.toJS;
SequencePrototype.__toJS = SequencePrototype.toObject;
SequencePrototype.inspect =
SequencePrototype.toSource = function() { return this.toString(); };


class IndexedSequence extends Sequence {

  toString() {
    return this.__toString('Seq [', ']');
  }

  toArray() {
    assertNotInfinite(this.length);
    var array = new Array(this.length || 0);
    array.length = this.forEach((v, i) => { array[i] = v; });
    return array;
  }

  toKeyedSeq() {
    return new KeyedIndexedSequence(this);
  }

  fromEntrySeq() {
    var sequence = this;
    var fromEntriesSequence = makeSequence();
    fromEntriesSequence.length = sequence.length;
    fromEntriesSequence.entrySeq = () => sequence;
    fromEntriesSequence.__iterateUncached = function (fn, reverse) {
      // Check if entry exists first so array access doesn't throw for holes
      // in the parent iteration.
      return sequence.__iterate(
        entry => entry && fn(entry[1], entry[0], this),
        reverse
      );
    }
    return fromEntriesSequence;
  }

  join(separator) {
    separator = separator !== undefined ? '' + separator : ',';
    var joined = '';
    this.forEach((v, ii) => {
      joined += (ii ? separator : '') + (v != null ? v : '');
    });
    return joined;
  }

  concat(...values) {
    var sequences = [this].concat(values).map(value => Sequence(value));
    var concatSequence = this.__makeSequence();
    concatSequence.length = sequences.reduce(
      (sum, seq) => sum != null && seq.length != null ? sum + seq.length : undefined, 0
    );
    concatSequence.__iterateUncached = function(fn, reverse, flipIndices) {
      if (flipIndices && !this.length) {
        // In order to reverse indices, first we must create a cached
        // representation. This ensures we will have the correct total length
        // so index reversal works as expected.
        return this.cacheResult().__iterate(fn, reverse, flipIndices);
      }
      var iterations = 0;
      var stoppedIteration;
      var maxIndex = flipIndices && this.length - 1;
      var maxSequencesIndex = sequences.length - 1;
      for (var ii = 0; ii <= maxSequencesIndex && !stoppedIteration; ii++) {
        var sequence = sequences[reverse ? maxSequencesIndex - ii : ii];
        if (!(sequence instanceof IndexedSequence)) {
          sequence = sequence.valueSeq();
        }
        iterations += sequence.__iterate((v, index) => {
          index += iterations;
          if (fn(v, flipIndices ? maxIndex - index : index, this) === false) {
            stoppedIteration = true;
            return false;
          }
        }, reverse); // intentionally do not pass flipIndices
      }
      return iterations;
    }
    return concatSequence;
  }

  reverse() {
    var sequence = this;
    var reversedSequence = sequence.__makeSequence();
    reversedSequence.reverse = () => sequence;
    reversedSequence.length = sequence.length;
    reversedSequence.__reversedIndices = sequence.__reversedIndices;
    reversedSequence.__iterateUncached = function (fn, reverse, flipIndices) {
      if (flipIndices && !this.length) {
        // In order to reverse indices, first we must create a cached
        // representation. This ensures we will have the correct total length
        // so index reversal works as expected.
        return this.cacheResult().__iterate(fn, reverse, flipIndices);
      }
      var i = flipIndices ? this.length : 0;
      return sequence.__iterate(
        v => fn(v, flipIndices ? --i : i++, this) !== false,
        !reverse
      );
    }
    return reversedSequence;
  }

  filter(predicate, thisArg) {
    return filterFactory(this, predicate, thisArg, false);
  }

  get(index, notSetValue) {
    index = wrapIndex(this, index);
    return this.find((_, key) => key === index, null, notSetValue);
  }

  indexOf(searchValue) {
    return this.findIndex(value => is(value, searchValue));
  }

  lastIndexOf(searchValue) {
    return this.toKeyedSeq().reverse().indexOf(searchValue);
  }

  findIndex(predicate, thisArg) {
    var key = this.findKey(predicate, thisArg);
    return key == null ? -1 : key;
  }

  findLastIndex(predicate, thisArg) {
    return this.toKeyedSeq().reverse().findIndex(predicate, thisArg);
  }

  slice(begin, end) {
    var sequence = this;
    if (wholeSlice(begin, end, sequence.length)) {
      return sequence;
    }
    // TODO: re-evaluate if this needs to be more complex than .skip().take()
    var sliceSequence = sequence.__makeSequence();
    var resolvedBegin = resolveBegin(begin, sequence.length);
    var resolvedEnd = resolveEnd(end, sequence.length);
    sliceSequence.length = sequence.length && resolvedEnd - resolvedBegin;
    sliceSequence.__reversedIndices = sequence.__reversedIndices;
    sliceSequence.__iterateUncached = function(fn, reverse, flipIndices) {
      if (reverse) {
        // TODO: reverse should be possible here.
        return this.cacheResult().__iterate(fn, reverse, flipIndices);
      }
      var reversedIndices = this.__reversedIndices ^ flipIndices;
      if (resolvedBegin !== resolvedBegin ||
          resolvedEnd !== resolvedEnd ||
          (reversedIndices && sequence.length == null)) {
        var exactLength = sequence.count();
        resolvedBegin = resolveBegin(begin, exactLength);
        resolvedEnd = resolveEnd(end, exactLength);
      }
      var iiBegin = reversedIndices ? sequence.length - resolvedEnd : resolvedBegin;
      var iiEnd = reversedIndices ? sequence.length - resolvedBegin : resolvedEnd;
      var lengthIterated = sequence.__iterate((v, ii) =>
        reversedIndices ?
          (iiEnd != null && ii >= iiEnd) || (ii >= iiBegin) && fn(v, ii - iiBegin, this) !== false :
          (ii < iiBegin) || (iiEnd == null || ii < iiEnd) && fn(v, ii - iiBegin, this) !== false,
        reverse, flipIndices
      );
      return this.length != null ? this.length : Math.max(0, lengthIterated - iiBegin);
    };
    return sliceSequence;
  }

  splice(index, removeNum /*, ...values*/) {
    var numArgs = arguments.length;
    removeNum = Math.max(removeNum | 0, 0);
    if (numArgs === 0 || (numArgs === 2 && !removeNum)) {
      return this;
    }
    index = resolveBegin(index, this.length);
    var spliced = this.slice(0, index);
    return numArgs === 1 ?
      spliced :
      spliced.concat(
        arrCopy(arguments, 2),
        this.slice(index + removeNum)
      );
  }

  flatten() {
    var sequence = this;
    var flatSequence = sequence.__makeSequence();
    flatSequence.__iterateUncached = function (fn, reverse, flipIndices) {
      if (flipIndices) {
        return this.cacheResult().__iterate(fn, reverse, flipIndices);
      }
      var index = 0;
      sequence.__iterate(
        seq => {
          index += Sequence(seq).__iterate(
            (v, i) => fn(v, index + i, this) !== false,
            reverse,
            flipIndices
          )
        },
        reverse,
        flipIndices
      );
      return index;
    };
    return flatSequence;
  }

  flatMap(mapper, thisArg) {
    return this.map(mapper, thisArg).flatten();
  }

  // Overrides to get length correct.

  skip(amount) {
    var sequence = this;
    if (amount === 0) {
      return sequence;
    }
    var skipSequence = sequence.__makeSequence();
    skipSequence.__iterateUncached = function (fn, reverse, flipIndices) {
      if (reverse) {
        // TODO: can we do a better job of this?
        return this.cacheResult().__iterate(fn, reverse, flipIndices)
      }
      var reversedIndices = sequence.__reversedIndices ^ flipIndices;
      var isSkipping = true;
      var indexOffset = 0;
      var skipped = 0;
      var length = sequence.__iterate((v, ii) => {
        if (isSkipping) {
          isSkipping = skipped++ < amount;
          if (!isSkipping) {
            indexOffset = ii;
          }
        }
        return isSkipping || fn(v, reversedIndices ? ii : ii - indexOffset, this) !== false;
      }, reverse, flipIndices);
      return reversedIndices ? indexOffset + 1 : length - indexOffset;
    };
    skipSequence.length = this.length && Math.max(0, this.length - amount);
    return skipSequence;
  }

  skipWhile(predicate, thisArg) {
    var sequence = this;
    var skipWhileSequence = sequence.__makeSequence();
    skipWhileSequence.__iterateUncached = function (fn, reverse, flipIndices) {
      if (reverse) {
        // TODO: can we do a better job of this?
        return this.cacheResult().__iterate(fn, reverse, flipIndices)
      }
      var reversedIndices = sequence.__reversedIndices ^ flipIndices;
      var isSkipping = true;
      var indexOffset = 0;
      var length = sequence.__iterate((v, ii, c) => {
        if (isSkipping) {
          isSkipping = predicate.call(thisArg, v, ii, c);
          if (!isSkipping) {
            indexOffset = ii;
          }
        }
        return isSkipping || fn(v, reversedIndices ? ii : ii - indexOffset, this) !== false;
      }, reverse, flipIndices);
      return reversedIndices ? indexOffset + 1 : length - indexOffset;
    };
    return skipWhileSequence;
  }

  groupBy(mapper, context) {
    return groupByFactory(this, mapper, context, false);
  }

  sortBy(mapper, comparator) {
    comparator = comparator || defaultComparator;
    var seq = this;
    return Sequence(this.entrySeq().toArray().sort(
      (a, b) => comparator(
        mapper(a[1], a[0], seq),
        mapper(b[1], b[0], seq)
      ) || a[0] - b[0]
    )).fromEntrySeq().valueSeq();
  }

  // abstract __iterateUncached(fn, reverse, flipIndices)

  __makeSequence() {
    return makeIndexedSequence(this);
  }
}

var IndexedSequencePrototype = IndexedSequence.prototype;
IndexedSequencePrototype.__toJS = IndexedSequencePrototype.toArray;
IndexedSequencePrototype.__toStringMapper = quoteString;
IndexedSequencePrototype.chain = IndexedSequencePrototype.flatMap;


class KeyedIndexedSequence extends Sequence {
  constructor(indexedSeq) {
    this._seq = indexedSeq;
    this.length = indexedSeq.length;
  }

  get(key, notSetValue) {
    return this._seq.get(key, notSetValue);
  }

  has(key) {
    return this._seq.has(key);
  }

  __iterate(fn, reverse) {
    return this._seq.__iterate(fn, reverse, reverse);
  }
}


class ObjectSequence extends Sequence {
  constructor(object) {
    var keys = Object.keys(object);
    this._object = object;
    this._keys = keys;
    this.length = keys.length;
  }

  toObject() {
    return this._object;
  }

  get(key, notSetValue) {
    if (notSetValue !== undefined && !this.has(key)) {
      return notSetValue;
    }
    return this._object[key];
  }

  has(key) {
    return this._object.hasOwnProperty(key);
  }

  __iterate(fn, reverse) {
    var object = this._object;
    var keys = this._keys;
    var maxIndex = keys.length - 1;
    for (var ii = 0; ii <= maxIndex; ii++) {
      var iteration = reverse ? maxIndex - ii : ii;
      if (fn(object[keys[iteration]], keys[iteration], object) === false) {
        break;
      }
    }
    return ii;
  }
}


class ArraySequence extends IndexedSequence {
  constructor(array) {
    this._array = array;
    this.length = array.length;
  }

  toArray() {
    return this._array;
  }

  get(index, notSetValue) {
    return this.has(index) ? this._array[wrapIndex(this, index)] : notSetValue;
  }

  has(index) {
    index = wrapIndex(this, index);
    return index >= 0 && index < this.length;
  }

  __iterate(fn, reverse, flipIndices) {
    var array = this._array;
    var maxIndex = array.length - 1;
    var ii, rr;

    var reversedIndices = reverse ^ flipIndices;
    for (ii = 0; ii <= maxIndex; ii++) {
      rr = maxIndex - ii;
      if (fn(array[reverse ? rr : ii], flipIndices ? rr : ii, array) === false) {
        return reversedIndices ? reverse ? rr : ii : array.length;
      }
    }
    return array.length;
  }
}


class SequenceIterator {
  toString() {
    return '[Iterator]';
  }
}

var SequenceIteratorPrototype = SequenceIterator.prototype;
SequenceIteratorPrototype[ITERATOR] = returnThis;
SequenceIteratorPrototype.inspect =
SequenceIteratorPrototype.toSource = function () { return this.toString(); }


function makeSequence() {
  return Object.create(SequencePrototype);
}

function makeIndexedSequence(parent) {
  var newSequence = Object.create(IndexedSequencePrototype);
  newSequence.__reversedIndices = parent ? parent.__reversedIndices : false;
  return newSequence;
}

function getInDeepSequence(seq, keyPath, notSetValue, pathOffset) {
  var nested = seq.get ? seq.get(keyPath[pathOffset], NOT_SET) : NOT_SET;
  if (nested === NOT_SET) {
    return notSetValue;
  }
  if (++pathOffset === keyPath.length) {
    return nested;
  }
  return getInDeepSequence(nested, keyPath, notSetValue, pathOffset);
}

function wholeSlice(begin, end, length) {
  return (begin === 0 || (length != null && begin <= -length)) &&
    (end == null || (length != null && end >= length));
}

function resolveBegin(begin, length) {
  return resolveIndex(begin, length, 0);
}

function resolveEnd(end, length) {
  return resolveIndex(end, length, length);
}

function resolveIndex(index, length, defaultIndex) {
  return index == null ?
    defaultIndex :
    index < 0 ?
      Math.max(0, length + index) :
      length ?
        Math.min(length, index) :
        index;
}

function valueMapper(v) {
  return v;
}

function entryMapper(v, k) {
  return [k, v];
}

function returnTrue() {
  return true;
}

function returnThis() {
  return this;
}

function increment(value) {
  return (value || 0) + 1;
}

/**
 * Sequence.prototype.filter and IndexedSequence.prototype.filter are so close
 * in behavior that it makes sense to build a factory with the few differences
 * encoded as booleans.
 */
function filterFactory(sequence, predicate, thisArg, useKeys) {
  var filterSequence = sequence.__makeSequence();
  filterSequence.__iterateUncached = function (fn, reverse, flipIndices) {
    var iterations = 0;
    sequence.__iterate((v, k, c) => {
      if (predicate.call(thisArg, v, k, c)) {
        if (fn(v, useKeys ? k : iterations, this) !== false) {
          iterations++;
        } else {
          return false;
        }
      }
    }, reverse, flipIndices);
    return iterations;
  };
  return filterSequence;
}

function groupByFactory(seq, mapper, context, useKeys) {
  var groups = OrderedMap.empty().withMutations(map => {
    seq.forEach((value, key, collection) => {
      var groupKey = mapper.call(context, value, key, seq);
      var group = map.get(groupKey);
      if (!group) {
        group = [];
        map.set(groupKey, group);
      }
      group.push(useKeys ? [key, value] : value);
    });
  })
  return groups.map(useKeys ?
    group => Sequence(group).fromEntrySeq() :
    group => Sequence(group)
  );
}

function not(predicate) {
  return function() {
    return !predicate.apply(this, arguments);
  }
}

function quoteString(value) {
  return typeof value === 'string' ? JSON.stringify(value) : value;
}

function defaultComparator(a, b) {
  return a > b ? 1 : a < b ? -1 : 0;
}

function wrapIndex(seq, index) {
  if (index < 0) {
    if (seq.length == null) {
      seq.cacheResult();
    }
    return seq.length + index;
  }
  return index;
}

function assertNotInfinite(length) {
  invariant(
    length !== Infinity,
    'Cannot perform this action with an infinite sequence.'
  );
}

function iteratorMapper(iter, fn) {
  var newIter = new SequenceIterator();
  newIter.next = () => {
    var step = iter.next();
    if (step.done) return step;
    step.value = fn(step.value);
    return step;
  };
  return newIter;
}
