package connections

import (
	"crypto/sha256"
	"encoding/hex"
)

func internalName(prefix, value string) string {
	sum := sha256.Sum256([]byte(value))
	return prefix + "_" + hex.EncodeToString(sum[:10])
}

func relationID(connectionID, catalog, schema, relation, relationType string) string {
	return internalName("rel", connectionID+"\x00"+catalog+"\x00"+schema+"\x00"+relation+"\x00"+relationType)
}
